import {
    MOBILITY_PROFILES,
} from "./mobility-profiles.js";
import { Navigation } from "./navigation.js";
import {
    NavigationInstance,
    NavigationRegistry,
    navigationForEntity,
} from "./navigation-registry.js";
import {
    DEFAULT_WORLD_DOMAIN_ID,
    World,
} from "./world.js";
import {
    validateWorldCoreSnapshot,
} from "./snapshot-validation.js";

const FORMAT = "world-core";
const FORMAT_VERSION = 1;

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
    const regions = [...navigation.regions.values()]
        .sort((a, b) =>
            a.id.localeCompare(b.id))
        .map(region => ({
            id: region.id,
        }));

    const nodes = [...navigation.nodes.values()]
        .sort((a, b) =>
            a.id.localeCompare(b.id))
        .map(node => ({
            id: node.id,
            x: node.position.x,
            y: node.position.y,
            junctionRadius:
                node.junctionRadius ?? 0,
            regionId:
                node.regionId ?? null,
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
                            traversalDelaySeconds:
                                effect.traversalDelaySeconds ?? 0,
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
        hierarchicalRouteCacheSize:
            navigation.hierarchicalRouteCacheSize,
        regionalRouteCacheSize:
            navigation.regionalRouteCacheSize,
        regions,
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
        hierarchicalRouteCacheSize:
            data.hierarchicalRouteCacheSize,
        regionalRouteCacheSize:
            data.regionalRouteCacheSize,
    });

    for (const region of data.regions ?? []) {
        navigation.addRegion(region);
    }

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
                    traversalDelaySeconds:
                        effect.traversalDelaySeconds ?? 0,
                },
            );
        }

        road.version = roadData.version;
    }

    navigation.invalidateAllRoutes();

    return navigation;
}

function serializeNavigationSource(
    navigation,
) {
    if (
        navigation instanceof
        NavigationInstance
    ) {
        throw new Error(
            "A standalone NavigationInstance cannot be serialized as a world navigation root; serialize its NavigationRegistry instead",
        );
    }

    if (
        navigation instanceof
        NavigationRegistry
    ) {
        navigation.assertInternalConsistency();

        return {
            type: "registry",
            defaultTopologyId:
                navigation.defaultTopologyId,
            topologies:
                [...navigation.topologies]
                    .sort(
                        ([a], [b]) =>
                            a.localeCompare(b),
                    )
                    .map(
                        ([
                            id,
                            topology,
                        ]) => ({
                            id,
                            navigation:
                                serializeNavigation(
                                    topology,
                                ),
                        }),
                    ),
            domainBindings:
                [...navigation.domainBindings]
                    .sort(
                        ([a], [b]) =>
                            a.localeCompare(b),
                    )
                    .map(
                        ([
                            domainId,
                            topologyId,
                        ]) => ({
                            domainId,
                            topologyId,
                        }),
                    ),
            domainRoadEffects:
                [...navigation.domainInstances]
                    .sort(
                        ([a], [b]) =>
                            a.localeCompare(b),
                    )
                    .flatMap(
                        ([
                            domainId,
                            instance,
                        ]) =>
                            [...instance.roadEffects]
                                .sort(
                                    ([a], [b]) =>
                                        a.localeCompare(b),
                                )
                                .flatMap(
                                    ([
                                        roadId,
                                        effects,
                                    ]) =>
                                        [...effects]
                                            .sort(
                                                ([a], [b]) =>
                                                    a.localeCompare(b),
                                            )
                                            .map(
                                                ([
                                                    effectId,
                                                    effect,
                                                ]) => ({
                                                    domainId,
                                                    roadId,
                                                    effectId,
                                                    blocked:
                                                        effect.blocked,
                                                    costMultiplier:
                                                        effect.costMultiplier,
                                                    traversalDelaySeconds:
                                                        effect.traversalDelaySeconds ?? 0,
                                                }),
                                            ),
                                ),
                    ),
        };
    }

    return serializeNavigation(
        navigation,
    );
}

function deserializeNavigationSource(
    data,
) {
    if (data?.type !== "registry") {
        return deserializeNavigation(
            data,
        );
    }

    const registry =
        new NavigationRegistry();

    for (
        const topology of
        data.topologies
    ) {
        registry.registerTopology(
            topology.id,
            deserializeNavigation(
                topology.navigation,
            ),
        );
    }

    if (
        data.defaultTopologyId != null
    ) {
        registry.setDefaultTopology(
            data.defaultTopologyId,
        );
    }

    for (
        const binding of
        data.domainBindings ?? []
    ) {
        registry.bindDomain(
            binding.domainId,
            binding.topologyId,
        );
    }

    for (
        const effect of
        data.domainRoadEffects ?? []
    ) {
        registry.setDomainRoadEffect(
            effect.domainId,
            effect.effectId,
            effect.roadId,
            {
                blocked:
                    effect.blocked,
                costMultiplier:
                    effect.costMultiplier,
                traversalDelaySeconds:
                    effect.traversalDelaySeconds ?? 0,
            },
        );
    }

    registry.assertInternalConsistency();
    return registry;
}

function serializeObstacles(world) {
    return [
        ...world.obstacleDomains.entries(),
    ]
        .sort(
            ([a], [b]) =>
                String(a).localeCompare(
                    String(b),
                ),
        )
        .map(
            ([
                obstacleId,
                domainId,
            ]) => ({
                ...clone(
                    world.getObstacle(
                        obstacleId,
                    ),
                ),
                domainId,
            }),
        );
}

function deserializeObstacles(
    world,
    obstacles,
) {
    for (
        const serialized of
        obstacles ?? []
    ) {
        const {
            domainId,
            ...obstacle
        } = clone(serialized);

        world.addObstacle(
            obstacle,
            {
                domainId:
                    domainId ??
                    DEFAULT_WORLD_DOMAIN_ID,
            },
        );
    }
}

function serializeEntities(
    world,
    navigation,
) {
    const routeIds = new Map();
    const routes = [];

    function registerRoute(
        route,
        topologyId,
    ) {
        let routeId = routeIds.get(route);

        if (routeId != null) {
            return routeId;
        }

        routeId = routes.length;
        routeIds.set(route, routeId);

        routes.push({
            id: routeId,
            topologyId:
                topologyId ?? null,
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

                const topologyId =
                    navigation instanceof
                    NavigationRegistry
                        ? navigation
                            .topologyIdForDomain(
                                entity.domainId ??
                                    DEFAULT_WORLD_DOMAIN_ID,
                            )
                        : null;

                if (
                    navigation instanceof
                        NavigationRegistry &&
                    topologyId == null
                ) {
                    throw new Error(
                        `Cannot serialize active journey without navigation topology: ${String(entity.id)}`,
                    );
                }

                serializedJourney = {
                    ...clone(journeyRest),
                    routeId:
                        registerRoute(
                            route,
                            topologyId,
                        ),
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
        routes.set(
            routeData.id,
            {
                topologyId:
                    routeData.topologyId ??
                    null,
                route: {
                    startNodeId:
                        routeData.startNodeId,
                    destinationNodeId:
                        routeData.destinationNodeId,
                    legs:
                        routeData.legs.map(
                            leg => ({
                                ...leg,
                            }),
                        ),
                    estimatedSeconds:
                        routeData.estimatedSeconds,
                },
            },
        );
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
            const routeRecord =
                routes.get(
                    serialized.journey
                        .routeId,
                );

            if (!routeRecord) {
                throw new Error(
                    `Missing serialized route ${serialized.journey.routeId}`,
                );
            }

            const {
                routeId,
                ...journeyRest
            } =
                serialized.journey;

            const entityNavigation =
                navigationForEntity(
                    navigation,
                    stored,
                );

            if (
                navigation instanceof
                    NavigationRegistry
            ) {
                const expectedTopologyId =
                    navigation
                        .topologyIdForDomain(
                            stored.domainId,
                        );

                if (
                    routeRecord.topologyId !==
                    expectedTopologyId
                ) {
                    throw new Error(
                        `Serialized route topology mismatch for entity: ${String(stored.id)}`,
                    );
                }
            }

            entityNavigation
                .adoptRoute?.(
                    routeRecord.route,
                );

            stored.journey = {
                ...clone(journeyRest),
                route:
                    routeRecord.route,
                validatedGraphRevision:
                    entityNavigation
                        .graphRevision,
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
        serializeEntities(
            world,
            navigation,
        );

    return {
        format: FORMAT,
        version: FORMAT_VERSION,

        navigation:
            serializeNavigationSource(
                navigation,
            ),

        world: {
            time: world.time,
            domains:
                [...world.domains.values()]
                    .sort(
                        (a, b) =>
                            a.handle -
                            b.handle,
                    )
                    .map(domain => ({
                        id: domain.id,
                    })),
            spatialCellSize:
                world.spatial.cellSize,
            obstacleCellSize:
                world.obstacles.index.cellSize,
            obstacles:
                serializeObstacles(world),
            localSteering:
                clone(world.localSteering),
            captureEvents:
                world.captureEvents,
            eventQueueLimit:
                world.eventQueueLimit,
            eventOverflowPolicy:
                world.eventOverflowPolicy,
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
    validateWorldCoreSnapshot(
        snapshot,
        {
            expectedFormat:
                FORMAT,
            expectedVersion:
                FORMAT_VERSION,
        },
    );

    const navigation =
        deserializeNavigationSource(
            snapshot.navigation,
        );

    const world = new World({
        spatialCellSize:
            snapshot.world.spatialCellSize,
        obstacleCellSize:
            snapshot.world.obstacleCellSize,
        domains:
            snapshot.world.domains ?? [],
        localSteering:
            snapshot.world.localSteering,
        captureEvents:
            snapshot.world.captureEvents,
        eventQueueLimit:
            snapshot.world.eventQueueLimit,
        eventOverflowPolicy:
            snapshot.world.eventOverflowPolicy,
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


    world.events.length = 0;

    if (
        navigation instanceof
        NavigationRegistry
    ) {
        for (
            const topology of
            navigation.topologies.values()
        ) {
            topology.invalidateAllRoutes();
        }

        navigation.assertInternalConsistency();
    } else {
        navigation.invalidateAllRoutes();
    }

    world.assertInternalConsistency();

    return {
        world,
        navigation,
    };
}

export const WORLD_CORE_SNAPSHOT_VERSION =
    FORMAT_VERSION;
