import {
    MOBILITY_PROFILES,
} from "./mobility-profiles.js";
import { Navigation } from "./navigation.js";
import { World } from "./world.js";

const FORMAT = "world-core";
const FORMAT_VERSION = 2;

function clone(value) {
    return value == null
        ? value
        : structuredClone(value);
}

function serializeMobility(mobility) {
    if (!mobility) return null;

    if (
        mobility.profileId &&
        MOBILITY_PROFILES[mobility.profileId] ===
            mobility
    ) {
        return {
            type: "profile",
            profileId: mobility.profileId,
        };
    }

    return {
        type: "inline",
        value: clone(mobility),
    };
}

function deserializeMobility(serialized) {
    if (!serialized) return undefined;

    if (serialized.type === "profile") {
        const profile =
            MOBILITY_PROFILES[
                serialized.profileId
            ];

        if (!profile) {
            throw new Error(
                `Unknown mobility profile in snapshot: ${serialized.profileId}`,
            );
        }

        return profile;
    }

    if (serialized.type === "inline") {
        return clone(serialized.value);
    }

    throw new Error(
        `Unknown serialized mobility type: ${serialized.type}`,
    );
}

function serializeNavigation(navigation) {
    const nodes = [...navigation.nodes.values()]
        .sort((a, b) =>
            a.id.localeCompare(b.id))
        .map(node => ({
            id: node.id,
            x: node.position.x,
            y: node.position.y,
            junctionRadius:
                node.junctionRadius ?? 0,
        }));

    const roads = [...navigation.roads.values()]
        .sort((a, b) =>
            a.id.localeCompare(b.id))
        .map(road => ({
            id: road.id,
            from: road.from,
            to: road.to,
            shape: road.points
                .slice(1, -1)
                .map(point => ({ ...point })),
            width: road.width,
            surface: road.surface,
            bidirectional: road.bidirectional,
            enabled: road.enabled,
            allowedProfiles:
                clone(road.allowedProfiles),
            blockedProfiles:
                clone(road.blockedProfiles),
            tags: clone(road.tags),
            effects:
                [...(
                    navigation.roadEffects
                        .get(road.id)
                        ?.entries() ?? []
                )]
                    .sort(
                        ([a], [b]) =>
                            String(a)
                                .localeCompare(
                                    String(b),
                                ),
                    )
                    .map(
                        ([id, effect]) => ({
                            id,
                            blocked:
                                effect.blocked,
                            costMultiplier:
                                effect.costMultiplier,
                        }),
                    ),
            version: road.version,
        }));

    return {
        spatialCellSize:
            navigation.nodeIndex.cellSize,
        routeCacheSize:
            navigation.routeCacheSize,
        routeCacheMaxLegs:
            navigation.routeCacheMaxLegs,
        routeCacheMaxTotalLegs:
            navigation.routeCacheMaxTotalLegs,
        nodes,
        roads,
    };
}

function deserializeNavigation(data) {
    const navigation = new Navigation({
        spatialCellSize:
            data.spatialCellSize,
        routeCacheSize:
            data.routeCacheSize,
        routeCacheMaxLegs:
            data.routeCacheMaxLegs,
        routeCacheMaxTotalLegs:
            data.routeCacheMaxTotalLegs,
    });

    for (const node of data.nodes) {
        navigation.addNode(node);
    }

    for (const roadData of data.roads) {
        const road = navigation.addRoad({
            id: roadData.id,
            from: roadData.from,
            to: roadData.to,
            shape: roadData.shape,
            width: roadData.width,
            surface: roadData.surface,
            bidirectional:
                roadData.bidirectional,
            enabled: roadData.enabled,
            allowedProfiles:
                roadData.allowedProfiles,
            blockedProfiles:
                roadData.blockedProfiles,
            tags: roadData.tags,
        });

        for (
            const effect of
            roadData.effects ?? []
        ) {
            navigation.setRoadEffect(
                effect.id,
                road.id,
                {
                    blocked:
                        effect.blocked,
                    costMultiplier:
                        effect.costMultiplier,
                },
            );
        }

        road.version = roadData.version;
    }

    navigation.invalidateAllRoutes();

    return navigation;
}

function serializeLodTiers(world) {
    if (!world.movementLodTiers) return null;

    return world.movementLodTiers.map(
        tier => ({
            maxDistance:
                Number.isFinite(
                    tier.maxDistance,
                )
                    ? tier.maxDistance
                    : null,
            interval: tier.interval,
        }),
    );
}

function serializeObstacles(world) {
    return [
        ...world.obstacles
            .obstacles.values(),
    ]
        .sort((a, b) =>
            String(a.id).localeCompare(
                String(b.id),
            ))
        .map(obstacle =>
            clone(obstacle));
}

function deserializeObstacles(
    world,
    obstacles,
) {
    for (
        const obstacle of
        obstacles ?? []
    ) {
        world.addObstacle(
            clone(obstacle),
        );
    }
}

function serializeEntities(world) {
    const routeIds = new Map();
    const routes = [];

    function registerRoute(route) {
        let routeId = routeIds.get(route);

        if (routeId != null) {
            return routeId;
        }

        routeId = routes.length;
        routeIds.set(route, routeId);

        routes.push({
            id: routeId,
            startNodeId: route.startNodeId,
            destinationNodeId:
                route.destinationNodeId,
            legs: route.legs.map(
                leg => ({ ...leg }),
            ),
            estimatedSeconds:
                route.estimatedSeconds,
        });

        return routeId;
    }

    const entities = [...world.entities.values()]
        .sort((a, b) =>
            String(a.id).localeCompare(
                String(b.id),
            ))
        .map(entity => {
            const {
                mobility,
                journey,
                ...rest
            } = entity;

            let serializedJourney = null;

            if (journey) {
                const {
                    route,
                    validatedGraphRevision,
                    ...journeyRest
                } = journey;

                serializedJourney = {
                    ...clone(journeyRest),
                    routeId:
                        registerRoute(route),
                };
            }

            return {
                entity: clone(rest),
                mobility:
                    serializeMobility(mobility),
                journey: serializedJourney,
            };
        });

    return {
        entities,
        routes,
        entityOrder:
            [...world.entities.keys()],
        movingOrder:
            [...world.movingEntities.keys()],
    };
}

function deserializeEntities(
    world,
    navigation,
    data,
) {
    const routes = new Map();

    for (const routeData of data.routes) {
        routes.set(routeData.id, {
            startNodeId:
                routeData.startNodeId,
            destinationNodeId:
                routeData.destinationNodeId,
            legs: routeData.legs.map(
                leg => ({ ...leg }),
            ),
            estimatedSeconds:
                routeData.estimatedSeconds,
        });
    }

    const serializedById =
        new Map(
            data.entities.map(
                serialized => [
                    serialized.entity.id,
                    serialized,
                ],
            ),
        );

    const entityOrder =
        data.entityOrder?.length
            ? data.entityOrder
            : data.entities.map(
                serialized =>
                    serialized.entity.id,
            );

    const pendingJourneys =
        new Map();

    for (const entityId of entityOrder) {
        const serialized =
            serializedById.get(
                entityId,
            );

        if (!serialized) {
            throw new Error(
                `Entity order references missing entity: ${entityId}`,
            );
        }

        const entity = {
            ...clone(serialized.entity),
        };

        const mobility =
            deserializeMobility(
                serialized.mobility,
            );

        if (mobility) {
            entity.mobility = mobility;
        }

        const stored =
            world.addEntity(entity);

        if (serialized.journey) {
            const route =
                routes.get(
                    serialized.journey
                        .routeId,
                );

            if (!route) {
                throw new Error(
                    `Missing serialized route ${serialized.journey.routeId}`,
                );
            }

            const {
                routeId,
                ...journeyRest
            } =
                serialized.journey;

            stored.journey = {
                ...clone(journeyRest),
                route,
                validatedGraphRevision:
                    navigation.graphRevision,
            };

            pendingJourneys.set(
                stored.id,
                stored,
            );
        }
    }

    if (
        world.entities.size !==
        data.entities.length
    ) {
        throw new Error(
            "Serialized entity order does not cover every entity",
        );
    }

    const movingOrder =
        data.movingOrder?.length
            ? data.movingOrder
            : [...pendingJourneys.keys()];

    for (const entityId of movingOrder) {
        const stored =
            pendingJourneys.get(
                entityId,
            );

        if (!stored) {
            throw new Error(
                `Moving order references entity without journey: ${entityId}`,
            );
        }

        world.markMoving(entityId);
        pendingJourneys.delete(
            entityId,
        );
    }

    for (
        const entityId of
        pendingJourneys.keys()
    ) {
        world.markMoving(entityId);
    }
}

export function serializeWorldCore(
    world,
    navigation,
) {
    const entityData =
        serializeEntities(world);

    return {
        format: FORMAT,
        version: FORMAT_VERSION,

        navigation:
            serializeNavigation(navigation),

        world: {
            time: world.time,
            spatialCellSize:
                world.spatial.cellSize,
            obstacleCellSize:
                world.obstacles.index.cellSize,
            obstacles:
                serializeObstacles(world),
            movementLodTiers:
                serializeLodTiers(world),
            interestPoints:
                clone(world.interestPoints),
            localSteering:
                clone(world.localSteering),
            captureEvents:
                world.captureEvents,
            movementAccumulators:
                [...world.movementAccumulators]
                    .sort(
                        ([a], [b]) =>
                            a - b,
                    ),
        },

        routes: entityData.routes,
        entities: entityData.entities,
        entityOrder:
            entityData.entityOrder,
        movingOrder:
            entityData.movingOrder,
    };
}

export function deserializeWorldCore(
    snapshot,
) {
    if (
        snapshot?.format !== FORMAT ||
        snapshot?.version !==
            FORMAT_VERSION
    ) {
        throw new Error(
            "Unsupported world-core snapshot format or version",
        );
    }

    const navigation =
        deserializeNavigation(
            snapshot.navigation,
        );

    const world = new World({
        spatialCellSize:
            snapshot.world.spatialCellSize,
        obstacleCellSize:
            snapshot.world.obstacleCellSize,
        movementLodTiers:
            snapshot.world.movementLodTiers,
        interestPoints:
            snapshot.world.interestPoints,
        localSteering:
            snapshot.world.localSteering,
        captureEvents:
            snapshot.world.captureEvents,
    });

    world.time = snapshot.world.time;

    deserializeObstacles(
        world,
        snapshot.world.obstacles,
    );

    deserializeEntities(
        world,
        navigation,
        {
            routes: snapshot.routes,
            entities: snapshot.entities,
            entityOrder:
                snapshot.entityOrder,
            movingOrder:
                snapshot.movingOrder,
        },
    );

    for (
        const [interval, accumulated] of
        snapshot.world
            .movementAccumulators ?? []
    ) {
        if (
            world.movementAccumulators.has(
                interval,
            )
        ) {
            world.movementAccumulators.set(
                interval,
                accumulated,
            );
        }
    }

    world.events.length = 0;
    navigation.invalidateAllRoutes();

    world.assertInternalConsistency();

    return {
        world,
        navigation,
    };
}

export const WORLD_CORE_SNAPSHOT_VERSION =
    FORMAT_VERSION;
