import {
    MOBILITY_PROFILES,
} from "./mobility-profiles.js";
import {
    DEFAULT_WORLD_DOMAIN_ID,
} from "./world.js";

function fail(path, message) {
    throw new Error(
        `Invalid world-core snapshot at ${path}: ${message}`,
    );
}

function requireObject(value, path) {
    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value)
    ) {
        fail(path, "expected object");
    }

    return value;
}

function requireArray(value, path) {
    if (!Array.isArray(value)) {
        fail(path, "expected array");
    }

    return value;
}

function requireFinite(value, path) {
    if (!Number.isFinite(value)) {
        fail(path, "expected finite number");
    }

    return value;
}

function requireNonNegative(
    value,
    path,
) {
    requireFinite(value, path);

    if (value < 0) {
        fail(
            path,
            "expected number >= 0",
        );
    }

    return value;
}

function requirePositive(
    value,
    path,
) {
    requireFinite(value, path);

    if (!(value > 0)) {
        fail(
            path,
            "expected number > 0",
        );
    }

    return value;
}

function requireInteger(
    value,
    path,
    min = 0,
) {
    if (
        !Number.isInteger(value) ||
        value < min
    ) {
        fail(
            path,
            `expected integer >= ${min}`,
        );
    }

    return value;
}

function requireBoolean(value, path) {
    if (typeof value !== "boolean") {
        fail(path, "expected boolean");
    }

    return value;
}

function requireId(value, path) {
    if (
        typeof value !== "string" &&
        typeof value !== "number"
    ) {
        fail(
            path,
            "expected string or number id",
        );
    }

    if (
        typeof value === "string" &&
        value.length === 0
    ) {
        fail(path, "id cannot be empty");
    }

    return value;
}

function requirePoint(value, path) {
    requireObject(value, path);
    requireFinite(
        value.x,
        `${path}.x`,
    );
    requireFinite(
        value.y,
        `${path}.y`,
    );
}

function requireUniqueIds(
    values,
    path,
    getId,
) {
    const seen = new Set();

    for (
        let index = 0;
        index < values.length;
        index++
    ) {
        const id =
            getId(
                values[index],
                index,
            );
        const key =
            typeof id +
            ":" +
            String(id);

        if (seen.has(key)) {
            fail(
                `${path}[${index}]`,
                `duplicate id ${String(id)}`,
            );
        }

        seen.add(key);
    }

    return seen;
}

function validateStringArray(
    value,
    path,
    {
        nullable = false,
    } = {},
) {
    if (
        nullable &&
        value === null
    ) {
        return;
    }

    requireArray(value, path);

    const seen = new Set();

    for (
        let index = 0;
        index < value.length;
        index++
    ) {
        const item =
            value[index];

        if (typeof item !== "string") {
            fail(
                `${path}[${index}]`,
                "expected string",
            );
        }

        if (seen.has(item)) {
            fail(
                `${path}[${index}]`,
                "duplicate value",
            );
        }

        seen.add(item);
    }
}

function validateObstacle(
    obstacle,
    path,
) {
    requireObject(
        obstacle,
        path,
    );

    requireId(
        obstacle.id,
        `${path}.id`,
    );

    if (
        obstacle.enabled !==
        undefined
    ) {
        requireBoolean(
            obstacle.enabled,
            `${path}.enabled`,
        );
    }

    if (
        obstacle.temporary !==
        undefined
    ) {
        requireBoolean(
            obstacle.temporary,
            `${path}.temporary`,
        );
    }

    if (
        obstacle.version !==
        undefined
    ) {
        requireInteger(
            obstacle.version,
            `${path}.version`,
            1,
        );
    }

    validateStringArray(
        obstacle.tags ?? [],
        `${path}.tags`,
    );

    if (
        obstacle.type ===
        "circle"
    ) {
        requirePoint(
            obstacle.center,
            `${path}.center`,
        );
        requireNonNegative(
            obstacle.radius,
            `${path}.radius`,
        );
        return;
    }

    if (
        obstacle.type ===
        "aabb"
    ) {
        requireFinite(
            obstacle.minX,
            `${path}.minX`,
        );
        requireFinite(
            obstacle.minY,
            `${path}.minY`,
        );
        requireFinite(
            obstacle.maxX,
            `${path}.maxX`,
        );
        requireFinite(
            obstacle.maxY,
            `${path}.maxY`,
        );

        if (
            obstacle.minX >
                obstacle.maxX ||
            obstacle.minY >
                obstacle.maxY
        ) {
            fail(
                path,
                "invalid AABB bounds",
            );
        }

        return;
    }

    if (
        obstacle.type ===
        "segment"
    ) {
        requirePoint(
            obstacle.a,
            `${path}.a`,
        );
        requirePoint(
            obstacle.b,
            `${path}.b`,
        );
        requireNonNegative(
            obstacle.radius ?? 0,
            `${path}.radius`,
        );
        return;
    }

    fail(
        `${path}.type`,
        "unsupported obstacle type",
    );
}

function validateMobility(
    mobility,
    path,
) {
    if (mobility === null) {
        return;
    }

    requireObject(
        mobility,
        path,
    );

    if (
        mobility.type ===
        "profile"
    ) {
        if (
            typeof mobility.profileId !==
                "string" ||
            mobility.profileId.length ===
                0
        ) {
            fail(
                `${path}.profileId`,
                "expected non-empty profile id",
            );
        }

        if (
            !MOBILITY_PROFILES[
                mobility.profileId
            ]
        ) {
            fail(
                `${path}.profileId`,
                "unknown mobility profile",
            );
        }

        return;
    }

    if (
        mobility.type ===
        "inline"
    ) {
        requireObject(
            mobility.value,
            `${path}.value`,
        );

        requirePositive(
            mobility.value.speed,
            `${path}.value.speed`,
        );

        return;
    }

    fail(
        `${path}.type`,
        "unsupported mobility encoding",
    );
}

function validateNavigationTopology(
    value,
    path,
) {
    const navigation =
        requireObject(
            value,
            path,
        );

    requirePositive(
        navigation.spatialCellSize,
        `${path}.spatialCellSize`,
    );
    requireInteger(
        navigation.routeCacheSize,
        `${path}.routeCacheSize`,
    );
    requireInteger(
        navigation.routeCacheMaxLegs,
        `${path}.routeCacheMaxLegs`,
    );
    requireInteger(
        navigation.routeCacheMaxTotalLegs,
        `${path}.routeCacheMaxTotalLegs`,
    );
    requireInteger(
        navigation.hierarchicalRouteCacheSize,
        `${path}.hierarchicalRouteCacheSize`,
    );
    requireInteger(
        navigation.regionalRouteCacheSize,
        `${path}.regionalRouteCacheSize`,
    );

    const regions =
        requireArray(
            navigation.regions ?? [],
            `${path}.regions`,
        );

    const regionIds =
        requireUniqueIds(
            regions,
            `${path}.regions`,
            region => {
                requireObject(
                    region,
                    `${path}.regions[]`,
                );

                if (
                    typeof region.id !==
                        "string" ||
                    region.id.length === 0
                ) {
                    fail(
                        `${path}.regions[].id`,
                        "expected non-empty string",
                    );
                }

                return region.id;
            },
        );

    const nodes =
        requireArray(
            navigation.nodes,
            `${path}.nodes`,
        );
    const nodeIds =
        requireUniqueIds(
            nodes,
            `${path}.nodes`,
            node => {
                requireObject(
                    node,
                    `${path}.nodes[]`,
                );
                return requireId(
                    node.id,
                    `${path}.nodes[].id`,
                );
            },
        );
    const nodeKey =
        id =>
            typeof id +
            ":" +
            String(id);

    for (
        let index = 0;
        index < nodes.length;
        index++
    ) {
        const node =
            nodes[index];
        const itemPath =
            `${path}.nodes[${index}]`;

        requireFinite(
            node.x,
            `${itemPath}.x`,
        );
        requireFinite(
            node.y,
            `${itemPath}.y`,
        );
        requireNonNegative(
            node.junctionRadius ?? 0,
            `${itemPath}.junctionRadius`,
        );

        if (
            node.regionId !== null &&
            node.regionId !== undefined &&
            !regionIds.has(
                "string:" +
                String(node.regionId),
            )
        ) {
            fail(
                `${itemPath}.regionId`,
                "references missing navigation region",
            );
        }
    }

    const roads =
        requireArray(
            navigation.roads,
            `${path}.roads`,
        );
    const roadIds =
        requireUniqueIds(
            roads,
            `${path}.roads`,
            road => {
                requireObject(
                    road,
                    `${path}.roads[]`,
                );
                return requireId(
                    road.id,
                    `${path}.roads[].id`,
                );
            },
        );

    const roadByKey =
        new Map(
            roads.map(
                road => [
                    nodeKey(road.id),
                    road,
                ],
            ),
        );

    for (
        let index = 0;
        index < roads.length;
        index++
    ) {
        const road =
            roads[index];
        const itemPath =
            `${path}.roads[${index}]`;

        if (
            !nodeIds.has(
                nodeKey(road.from),
            )
        ) {
            fail(
                `${itemPath}.from`,
                "references missing node",
            );
        }

        if (
            !nodeIds.has(
                nodeKey(road.to),
            )
        ) {
            fail(
                `${itemPath}.to`,
                "references missing node",
            );
        }

        requirePositive(
            road.width,
            `${itemPath}.width`,
        );

        if (
            typeof road.surface !==
            "string"
        ) {
            fail(
                `${itemPath}.surface`,
                "expected string",
            );
        }

        requireBoolean(
            road.bidirectional,
            `${itemPath}.bidirectional`,
        );
        requireBoolean(
            road.enabled,
            `${itemPath}.enabled`,
        );

        validateStringArray(
            road.allowedProfiles,
            `${itemPath}.allowedProfiles`,
            {
                nullable: true,
            },
        );
        validateStringArray(
            road.blockedProfiles ?? [],
            `${itemPath}.blockedProfiles`,
        );
        validateStringArray(
            road.tags ?? [],
            `${itemPath}.tags`,
        );

        const shape =
            requireArray(
                road.shape,
                `${itemPath}.shape`,
            );

        for (
            let pointIndex = 0;
            pointIndex <
                shape.length;
            pointIndex++
        ) {
            requirePoint(
                shape[pointIndex],
                `${path}.shape[${pointIndex}]`,
            );
        }

        requireInteger(
            road.version,
            `${itemPath}.version`,
            1,
        );

        const effects =
            requireArray(
                road.effects ?? [],
                `${itemPath}.effects`,
            );

        requireUniqueIds(
            effects,
            `${itemPath}.effects`,
            effect => {
                requireObject(
                    effect,
                    `${path}.effects[]`,
                );

                if (
                    typeof effect.id !==
                        "string" ||
                    effect.id.length ===
                        0
                ) {
                    fail(
                        `${path}.effects[].id`,
                        "expected non-empty string",
                    );
                }

                return effect.id;
            },
        );

        for (
            let effectIndex = 0;
            effectIndex <
                effects.length;
            effectIndex++
        ) {
            const effect =
                effects[effectIndex];
            const effectPath =
                `${path}.effects[${effectIndex}]`;

            requireBoolean(
                effect.blocked,
                `${effectPath}.blocked`,
            );
            requireFinite(
                effect.costMultiplier,
                `${effectPath}.costMultiplier`,
            );

            if (
                effect.costMultiplier <
                1
            ) {
                fail(
                    `${effectPath}.costMultiplier`,
                    "expected number >= 1",
                );
            }
        }

    }

    return {
        nodeIds,
        roadIds,
        roadByKey,
        nodeKey,
    };
}

export function validateWorldCoreSnapshot(
    snapshot,
    {
        expectedFormat =
            "world-core",
        expectedVersion = 1,
    } = {},
) {
    requireObject(
        snapshot,
        "$",
    );

    if (
        snapshot.format !==
        expectedFormat
    ) {
        fail(
            "$.format",
            `expected ${expectedFormat}`,
        );
    }

    if (
        snapshot.version !==
        expectedVersion
    ) {
        fail(
            "$.version",
            `expected version ${expectedVersion}`,
        );
    }

    const navigationSnapshot =
        requireObject(
            snapshot.navigation,
            "$.navigation",
        );

    const navigationContexts =
        new Map();
    const navigationBindingByDomain =
        new Map();
    let navigationRegistry =
        null;
    let defaultNavigationContext =
        null;

    if (
        navigationSnapshot.type ===
        "registry"
    ) {
        navigationRegistry =
            navigationSnapshot;

        const topologies =
            requireArray(
                navigationRegistry.topologies,
                "$.navigation.topologies",
            );

        requireUniqueIds(
            topologies,
            "$.navigation.topologies",
            topology => {
                requireObject(
                    topology,
                    "$.navigation.topologies[]",
                );

                if (
                    typeof topology.id !==
                        "string" ||
                    topology.id.length ===
                        0
                ) {
                    fail(
                        "$.navigation.topologies[].id",
                        "expected non-empty string",
                    );
                }

                return topology.id;
            },
        );

        for (
            let index = 0;
            index < topologies.length;
            index++
        ) {
            const topology =
                topologies[index];
            const context =
                validateNavigationTopology(
                    topology.navigation,
                    `$.navigation.topologies[${index}].navigation`,
                );

            navigationContexts.set(
                topology.id,
                context,
            );
        }

        if (
            navigationRegistry
                .defaultTopologyId !==
                null
        ) {
            if (
                typeof navigationRegistry
                    .defaultTopologyId !==
                    "string" ||
                !navigationContexts.has(
                    navigationRegistry
                        .defaultTopologyId,
                )
            ) {
                fail(
                    "$.navigation.defaultTopologyId",
                    "references missing navigation topology",
                );
            }

            defaultNavigationContext =
                navigationContexts.get(
                    navigationRegistry
                        .defaultTopologyId,
                );
        }

        const bindings =
            requireArray(
                navigationRegistry
                    .domainBindings ?? [],
                "$.navigation.domainBindings",
            );

        const seenBindings =
            new Set();

        for (
            let index = 0;
            index < bindings.length;
            index++
        ) {
            const binding =
                requireObject(
                    bindings[index],
                    `$.navigation.domainBindings[${index}]`,
                );

            if (
                typeof binding.domainId !==
                    "string" ||
                binding.domainId.length ===
                    0
            ) {
                fail(
                    `$.navigation.domainBindings[${index}].domainId`,
                    "expected non-empty string",
                );
            }

            if (
                seenBindings.has(
                    binding.domainId,
                )
            ) {
                fail(
                    `$.navigation.domainBindings[${index}].domainId`,
                    "duplicate domain binding",
                );
            }

            seenBindings.add(
                binding.domainId,
            );
            navigationBindingByDomain.set(
                binding.domainId,
                binding.topologyId,
            );

            if (
                typeof binding.topologyId !==
                    "string" ||
                !navigationContexts.has(
                    binding.topologyId,
                )
            ) {
                fail(
                    `$.navigation.domainBindings[${index}].topologyId`,
                    "references missing navigation topology",
                );
            }
        }
    } else {
        defaultNavigationContext =
            validateNavigationTopology(
                navigationSnapshot,
                "$.navigation",
            );
    }

    const world =
        requireObject(
            snapshot.world,
            "$.world",
        );

    requireNonNegative(
        world.time,
        "$.world.time",
    );
    requirePositive(
        world.spatialCellSize,
        "$.world.spatialCellSize",
    );
    requirePositive(
        world.obstacleCellSize,
        "$.world.obstacleCellSize",
    );

    const domains =
        requireArray(
            world.domains ?? [
                {
                    id:
                        DEFAULT_WORLD_DOMAIN_ID,
                },
            ],
            "$.world.domains",
        );

    const domainIds =
        requireUniqueIds(
            domains,
            "$.world.domains",
            domain => {
                requireObject(
                    domain,
                    "$.world.domains[]",
                );

                if (
                    typeof domain.id !==
                        "string" ||
                    domain.id.length === 0
                ) {
                    fail(
                        "$.world.domains[].id",
                        "expected non-empty string",
                    );
                }

                return domain.id;
            },
        );

    if (
        !domainIds.has(
            "string:" +
                DEFAULT_WORLD_DOMAIN_ID,
        )
    ) {
        fail(
            "$.world.domains",
            `missing required default domain ${DEFAULT_WORLD_DOMAIN_ID}`,
        );
    }

    if (navigationRegistry) {
        for (
            let index = 0;
            index <
                navigationRegistry
                    .domainBindings.length;
            index++
        ) {
            const binding =
                navigationRegistry
                    .domainBindings[
                        index
                    ];

            if (
                !domainIds.has(
                    "string:" +
                        binding.domainId,
                )
            ) {
                fail(
                    `$.navigation.domainBindings[${index}].domainId`,
                    "references missing world domain",
                );
            }
        }
    }

    const obstacles =
        requireArray(
            world.obstacles ?? [],
            "$.world.obstacles",
        );

    requireUniqueIds(
        obstacles,
        "$.world.obstacles",
        obstacle => {
            validateObstacle(
                obstacle,
                "$.world.obstacles[]",
            );

            return obstacle.id;
        },
    );

    for (
        let index = 0;
        index < obstacles.length;
        index++
    ) {
        const domainId =
            obstacles[index]
                .domainId ??
            DEFAULT_WORLD_DOMAIN_ID;

        if (
            typeof domainId !==
                "string" ||
            domainId.length === 0
        ) {
            fail(
                `$.world.obstacles[${index}].domainId`,
                "expected non-empty string",
            );
        }

        if (
            !domainIds.has(
                "string:" +
                    domainId,
            )
        ) {
            fail(
                `$.world.obstacles[${index}].domainId`,
                "references missing world domain",
            );
        }
    }

    const interestPoints =
        requireArray(
            world.interestPoints ?? [],
            "$.world.interestPoints",
        );

    for (
        let index = 0;
        index <
            interestPoints.length;
        index++
    ) {
        requirePoint(
            interestPoints[index],
            `$.world.interestPoints[${index}]`,
        );
    }

    const simulationRegions =
        requireArray(
            world.simulationRegions ?? [],
            "$.world.simulationRegions",
        );

    requireUniqueIds(
        simulationRegions,
        "$.world.simulationRegions",
        region => {
            requireObject(
                region,
                "$.world.simulationRegions[]",
            );

            if (
                typeof region.id !==
                    "string" ||
                region.id.length === 0
            ) {
                fail(
                    "$.world.simulationRegions[].id",
                    "expected non-empty string",
                );
            }

            return region.id;
        },
    );

    for (
        let index = 0;
        index < simulationRegions.length;
        index++
    ) {
        const region =
            simulationRegions[index];
        const path =
            `$.world.simulationRegions[${index}]`;

        requireFinite(
            region.minX,
            `${path}.minX`,
        );
        requireFinite(
            region.minY,
            `${path}.minY`,
        );
        requireFinite(
            region.maxX,
            `${path}.maxX`,
        );
        requireFinite(
            region.maxY,
            `${path}.maxY`,
        );

        if (
            region.minX > region.maxX ||
            region.minY > region.maxY
        ) {
            fail(
                path,
                "invalid simulation region bounds",
            );
        }

        requireFinite(
            region.priority,
            `${path}.priority`,
        );

        if (
            typeof region.detailLevel !==
                "string" ||
            region.detailLevel.length ===
                0
        ) {
            fail(
                `${path}.detailLevel`,
                "expected non-empty string",
            );
        }

        if (
            region.movementInterval !==
            null
        ) {
            requireNonNegative(
                region.movementInterval,
                `${path}.movementInterval`,
            );
        }

        requireBoolean(
            region.enabled,
            `${path}.enabled`,
        );
    }

    if (
        world.movementLodTiers !==
        null
    ) {
        const tiers =
            requireArray(
                world.movementLodTiers,
                "$.world.movementLodTiers",
            );

        if (tiers.length === 0) {
            fail(
                "$.world.movementLodTiers",
                "expected null or a non-empty array",
            );
        }

        let previous =
            -Infinity;

        for (
            let index = 0;
            index < tiers.length;
            index++
        ) {
            const tier =
                requireObject(
                    tiers[index],
                    `$.world.movementLodTiers[${index}]`,
                );
            const distance =
                tier.maxDistance ===
                null
                    ? Infinity
                    : requireNonNegative(
                        tier.maxDistance,
                        `$.world.movementLodTiers[${index}].maxDistance`,
                    );

            if (
                !(distance >
                    previous)
            ) {
                fail(
                    `$.world.movementLodTiers[${index}].maxDistance`,
                    "LOD distances must increase",
                );
            }

            requireNonNegative(
                tier.interval,
                `$.world.movementLodTiers[${index}].interval`,
            );

            previous =
                distance;
        }
    }

    requireBoolean(
        world.captureEvents,
        "$.world.captureEvents",
    );

    requireInteger(
        world.eventQueueLimit,
        "$.world.eventQueueLimit",
    );

    if (
        world.eventOverflowPolicy !==
            "drop-newest" &&
        world.eventOverflowPolicy !==
            "drop-oldest" &&
        world.eventOverflowPolicy !==
            "throw"
    ) {
        fail(
            "$.world.eventOverflowPolicy",
            "unsupported event overflow policy",
        );
    }

    const routes =
        requireArray(
            snapshot.routes,
            "$.routes",
        );
    const routeIds =
        requireUniqueIds(
            routes,
            "$.routes",
            route => {
                requireObject(
                    route,
                    "$.routes[]",
                );
                return requireInteger(
                    route.id,
                    "$.routes[].id",
                );
            },
        );

    const routeById =
        new Map(
            routes.map(route => [
                route.id,
                route,
            ]),
        );
    const routeContextById =
        new Map();

    for (
        let index = 0;
        index < routes.length;
        index++
    ) {
        const route =
            routes[index];
        const path =
            `$.routes[${index}]`;

        let context =
            defaultNavigationContext;

        if (navigationRegistry) {
            if (
                typeof route.topologyId !==
                    "string" ||
                route.topologyId.length ===
                    0
            ) {
                fail(
                    `${path}.topologyId`,
                    "expected navigation topology id",
                );
            }

            context =
                navigationContexts.get(
                    route.topologyId,
                ) ?? null;

            if (!context) {
                fail(
                    `${path}.topologyId`,
                    "references missing navigation topology",
                );
            }
        } else if (
            route.topologyId !==
                undefined &&
            route.topologyId !== null
        ) {
            fail(
                `${path}.topologyId`,
                "unexpected topology id for single navigation snapshot",
            );
        }

        if (!context) {
            fail(
                path,
                "no navigation topology is available for route",
            );
        }

        routeContextById.set(
            route.id,
            context,
        );

        const {
            nodeIds,
            roadIds,
            roadByKey,
            nodeKey,
        } = context;

        if (
            !nodeIds.has(
                nodeKey(
                    route.startNodeId,
                ),
            )
        ) {
            fail(
                `${path}.startNodeId`,
                "references missing node",
            );
        }

        if (
            !nodeIds.has(
                nodeKey(
                    route.destinationNodeId,
                ),
            )
        ) {
            fail(
                `${path}.destinationNodeId`,
                "references missing node",
            );
        }

        requireNonNegative(
            route.estimatedSeconds,
            `${path}.estimatedSeconds`,
        );

        const legs =
            requireArray(
                route.legs,
                `${path}.legs`,
            );

        for (
            let legIndex = 0;
            legIndex < legs.length;
            legIndex++
        ) {
            const leg =
                requireObject(
                    legs[legIndex],
                    `${path}.legs[${legIndex}]`,
                );

            if (
                !roadIds.has(
                    nodeKey(
                        leg.roadId,
                    ),
                )
            ) {
                fail(
                    `${path}.legs[${legIndex}].roadId`,
                    "references missing road",
                );
            }

            requireBoolean(
                leg.reversed,
                `${path}.legs[${legIndex}].reversed`,
            );
            requireInteger(
                leg.roadVersion,
                `${path}.legs[${legIndex}].roadVersion`,
                1,
            );
        }

        let currentNodeId =
            route.startNodeId;

        for (
            let legIndex = 0;
            legIndex < legs.length;
            legIndex++
        ) {
            const leg = legs[legIndex];
            const road =
                roadByKey.get(
                    nodeKey(leg.roadId),
                );

            if (!road) {
                fail(
                    `${path}.legs[${legIndex}].roadId`,
                    "references missing road",
                );
            }

            if (leg.reversed) {
                if (!road.bidirectional) {
                    fail(
                        `${path}.legs[${legIndex}]`,
                        "uses one-way road in reverse",
                    );
                }

                if (
                    nodeKey(road.to) !==
                    nodeKey(currentNodeId)
                ) {
                    fail(
                        `${path}.legs[${legIndex}]`,
                        "route leg is not connected to previous leg",
                    );
                }

                currentNodeId =
                    road.from;
            } else {
                if (
                    nodeKey(road.from) !==
                    nodeKey(currentNodeId)
                ) {
                    fail(
                        `${path}.legs[${legIndex}]`,
                        "route leg is not connected to previous leg",
                    );
                }

                currentNodeId =
                    road.to;
            }
        }

        if (
            nodeKey(currentNodeId) !==
            nodeKey(
                route.destinationNodeId,
            )
        ) {
            fail(
                path,
                "route does not end at destination node",
            );
        }
    }

    const entities =
        requireArray(
            snapshot.entities,
            "$.entities",
        );

    const entityIds =
        requireUniqueIds(
            entities,
            "$.entities",
            serialized => {
                requireObject(
                    serialized,
                    "$.entities[]",
                );
                requireObject(
                    serialized.entity,
                    "$.entities[].entity",
                );

                return requireId(
                    serialized.entity.id,
                    "$.entities[].entity.id",
                );
            },
        );

    const nodeKey =
        id =>
            typeof id +
            ":" +
            String(id);

    const entityByKey =
        new Map(
            entities.map(
                serialized => [
                    nodeKey(
                        serialized.entity.id,
                    ),
                    serialized,
                ],
            ),
        );
    let journeyCount = 0;

    for (
        let index = 0;
        index <
            entities.length;
        index++
    ) {
        const serialized =
            entities[index];
        const path =
            `$.entities[${index}]`;
        const entity =
            serialized.entity;

        requirePoint(
            entity.position,
            `${path}.entity.position`,
        );

        const entityDomainId =
            entity.domainId ??
            DEFAULT_WORLD_DOMAIN_ID;

        if (
            typeof entityDomainId !==
                "string" ||
            entityDomainId.length === 0
        ) {
            fail(
                `${path}.entity.domainId`,
                "expected non-empty string",
            );
        }

        if (
            !domainIds.has(
                "string:" +
                    entityDomainId,
            )
        ) {
            fail(
                `${path}.entity.domainId`,
                "references missing world domain",
            );
        }

        if (
            entity.body?.radius !==
            undefined
        ) {
            requireNonNegative(
                entity.body.radius,
                `${path}.entity.body.radius`,
            );
        }

        if (
            entity.simulation
                ?.movementInterval !==
                undefined &&
            entity.simulation
                ?.movementInterval !==
                null
        ) {
            requireNonNegative(
                entity.simulation
                    .movementInterval,
                `${path}.entity.simulation.movementInterval`,
            );
        }

        validateMobility(
            serialized.mobility,
            `${path}.mobility`,
        );

        if (
            serialized.journey !==
            null
        ) {
            journeyCount++;

            const journey =
                requireObject(
                    serialized.journey,
                    `${path}.journey`,
                );

            if (
                !routeIds.has(
                    "number:" +
                    String(
                        journey.routeId,
                    ),
                )
            ) {
                fail(
                    `${path}.journey.routeId`,
                    "references missing route",
                );
            }

            const route =
                routeById.get(
                    journey.routeId,
                );
            const routeContext =
                routeContextById.get(
                    journey.routeId,
                );

            if (
                !route ||
                !routeContext
            ) {
                fail(
                    `${path}.journey.routeId`,
                    "references invalid route context",
                );
            }

            if (navigationRegistry) {
                const domainId =
                    entity.domainId ??
                    DEFAULT_WORLD_DOMAIN_ID;
                const expectedTopologyId =
                    navigationBindingByDomain
                        .get(domainId) ??
                    navigationRegistry
                        .defaultTopologyId;

                if (
                    expectedTopologyId == null
                ) {
                    fail(
                        `${path}.journey`,
                        "entity domain has no navigation topology",
                    );
                }

                if (
                    route.topologyId !==
                    expectedTopologyId
                ) {
                    fail(
                        `${path}.journey.routeId`,
                        "route topology does not match entity domain binding",
                    );
                }
            }

            const {
                nodeIds,
                roadIds,
                roadByKey,
            } = routeContext;

            if (
                !nodeIds.has(
                    nodeKey(
                        journey.destinationNodeId,
                    ),
                )
            ) {
                fail(
                    `${path}.journey.destinationNodeId`,
                    "references missing node",
                );
            }

            if (
                nodeKey(
                    journey.destinationNodeId,
                ) !==
                nodeKey(
                    route.destinationNodeId,
                )
            ) {
                fail(
                    `${path}.journey.destinationNodeId`,
                    "does not match route destination",
                );
            }

            requireInteger(
                journey.legIndex,
                `${path}.journey.legIndex`,
            );
            requireInteger(
                journey.pointIndex,
                `${path}.journey.pointIndex`,
            );

            if (
                journey.legIndex >
                route.legs.length
            ) {
                fail(
                    `${path}.journey.legIndex`,
                    "exceeds route leg count",
                );
            }

            if (
                journey.entryPoint !==
                null
            ) {
                requirePoint(
                    journey.entryPoint,
                    `${path}.journey.entryPoint`,
                );
            }

            let prefix = null;

            if (
                journey.prefixLeg !==
                null
            ) {
                prefix =
                    requireObject(
                        journey.prefixLeg,
                        `${path}.journey.prefixLeg`,
                    );

                if (
                    !roadIds.has(
                        nodeKey(
                            prefix.roadId,
                        ),
                    )
                ) {
                    fail(
                        `${path}.journey.prefixLeg.roadId`,
                        "references missing road",
                    );
                }

                requireBoolean(
                    prefix.reversed,
                    `${path}.journey.prefixLeg.reversed`,
                );
                requireInteger(
                    prefix.roadVersion,
                    `${path}.journey.prefixLeg.roadVersion`,
                    1,
                );

                if (
                    prefix.startSegmentIndex !==
                    undefined
                ) {
                    requireInteger(
                        prefix.startSegmentIndex,
                        `${path}.journey.prefixLeg.startSegmentIndex`,
                    );

                    const prefixRoad =
                        roadByKey.get(
                            nodeKey(
                                prefix.roadId,
                            ),
                        );

                    if (
                        prefix.startSegmentIndex >
                        prefixRoad.shape.length
                    ) {
                        fail(
                            `${path}.journey.prefixLeg.startSegmentIndex`,
                            "outside road segment range",
                        );
                    }
                }
            }

            if (
                prefix &&
                journey.legIndex !== 0
            ) {
                fail(
                    `${path}.journey.legIndex`,
                    "prefix leg requires legIndex 0",
                );
            }

            if (
                journey.entryPoint !== null &&
                journey.legIndex !== 0
            ) {
                fail(
                    `${path}.journey.legIndex`,
                    "entry point requires legIndex 0",
                );
            }

            const currentLeg =
                prefix ??
                route.legs[
                    journey.legIndex
                ] ??
                null;

            if (
                !currentLeg &&
                !(
                    journey.entryPoint !== null &&
                    route.legs.length === 0 &&
                    journey.legIndex === 0
                )
            ) {
                fail(
                    `${path}.journey`,
                    "active journey has no remaining leg or entry point",
                );
            }

            if (currentLeg) {
                const currentRoad =
                    roadByKey.get(
                        nodeKey(
                            currentLeg.roadId,
                        ),
                    );
                const pointCount =
                    currentRoad.shape.length +
                    2;

                if (
                    journey.pointIndex >=
                    pointCount
                ) {
                    fail(
                        `${path}.journey.pointIndex`,
                        "outside current road point range",
                    );
                }
            }
        }
    }

    const validateOrder = (
        order,
        path,
        {
            requireJourney = false,
        } = {},
    ) => {
        requireArray(
            order,
            path,
        );

        const seen =
            new Set();

        for (
            let index = 0;
            index < order.length;
            index++
        ) {
            const id =
                requireId(
                    order[index],
                    `${path}[${index}]`,
                );
            const key =
                nodeKey(id);

            if (seen.has(key)) {
                fail(
                    `${path}[${index}]`,
                    "duplicate entity id",
                );
            }

            if (
                !entityIds.has(key)
            ) {
                fail(
                    `${path}[${index}]`,
                    "references missing entity",
                );
            }

            if (requireJourney) {
                const serialized =
                    entityByKey.get(key);

                if (
                    !serialized?.journey
                ) {
                    fail(
                        `${path}[${index}]`,
                        "moving entity has no journey",
                    );
                }
            }

            seen.add(key);
        }

        return seen;
    };

    const entityOrder =
        validateOrder(
            snapshot.entityOrder,
            "$.entityOrder",
        );

    if (
        entityOrder.size !==
        entities.length
    ) {
        fail(
            "$.entityOrder",
            "must contain every entity exactly once",
        );
    }

    const movingOrder =
        validateOrder(
            snapshot.movingOrder,
            "$.movingOrder",
            {
                requireJourney: true,
            },
        );

    if (
        movingOrder.size !==
        journeyCount
    ) {
        fail(
            "$.movingOrder",
            "must contain every entity with an active journey exactly once",
        );
    }

    const simulationRegionAt = position => {
        let best = null;
        let bestArea = Infinity;

        for (
            const region of
            simulationRegions
        ) {
            if (!region.enabled) {
                continue;
            }

            if (
                position.x < region.minX ||
                position.x > region.maxX ||
                position.y < region.minY ||
                position.y > region.maxY
            ) {
                continue;
            }

            const area =
                (region.maxX -
                    region.minX) *
                (region.maxY -
                    region.minY);

            if (
                !best ||
                region.priority >
                    best.priority ||
                (
                    region.priority ===
                        best.priority &&
                    area < bestArea
                ) ||
                (
                    region.priority ===
                        best.priority &&
                    area === bestArea &&
                    region.id <
                        best.id
                )
            ) {
                best = region;
                bestArea = area;
            }
        }

        return best;
    };

    const expectedIntervals =
        new Set();
    const tiers =
        world.movementLodTiers;
    const movingIds =
        snapshot.movingOrder;

    for (const entityId of movingIds) {
        const serialized =
            entityByKey.get(
                nodeKey(entityId),
            );
        const entity =
            serialized.entity;
        const explicitInterval =
            entity.simulation
                ?.movementInterval;

        if (
            explicitInterval !==
            undefined &&
            explicitInterval !== null
        ) {
            if (explicitInterval > 0) {
                expectedIntervals.add(
                    explicitInterval,
                );
            }

            continue;
        }

        const simulationRegion =
            simulationRegionAt(
                entity.position,
            );

        if (
            simulationRegion &&
            simulationRegion.movementInterval !==
                null
        ) {
            if (
                simulationRegion.movementInterval >
                0
            ) {
                expectedIntervals.add(
                    simulationRegion.movementInterval,
                );
            }

            continue;
        }

        if (
            tiers &&
            interestPoints.length > 0
        ) {
            let nearestSquared =
                Infinity;

            for (
                const point of
                interestPoints
            ) {
                const dx =
                    entity.position.x -
                    point.x;
                const dy =
                    entity.position.y -
                    point.y;
                const squared =
                    dx * dx +
                    dy * dy;

                if (
                    squared <
                    nearestSquared
                ) {
                    nearestSquared =
                        squared;
                }
            }

            let selectedTier =
                tiers[
                    tiers.length - 1
                ];

            for (const tier of tiers) {
                const maxDistance =
                    tier.maxDistance ===
                    null
                        ? Infinity
                        : tier.maxDistance;

                if (
                    nearestSquared <=
                    maxDistance *
                        maxDistance
                ) {
                    selectedTier =
                        tier;
                    break;
                }
            }

            expectedIntervals.add(
                selectedTier.interval,
            );
        }
    }

    const accumulators =
        requireArray(
            world.movementAccumulators ?? [],
            "$.world.movementAccumulators",
        );
    const accumulatorIntervals =
        new Set();

    for (
        let index = 0;
        index <
            accumulators.length;
        index++
    ) {
        const pair =
            requireArray(
                accumulators[index],
                `$.world.movementAccumulators[${index}]`,
            );

        if (pair.length !== 2) {
            fail(
                `$.world.movementAccumulators[${index}]`,
                "expected [interval, accumulated]",
            );
        }

        const interval =
            requireNonNegative(
                pair[0],
                `$.world.movementAccumulators[${index}][0]`,
            );
        const accumulated =
            requireNonNegative(
                pair[1],
                `$.world.movementAccumulators[${index}][1]`,
            );

        if (
            accumulatorIntervals.has(
                interval,
            )
        ) {
            fail(
                `$.world.movementAccumulators[${index}][0]`,
                "duplicate movement interval",
            );
        }

        accumulatorIntervals.add(
            interval,
        );

        if (
            !expectedIntervals.has(
                interval,
            )
        ) {
            fail(
                `$.world.movementAccumulators[${index}][0]`,
                "interval has no scheduled movers",
            );
        }

        if (
            interval === 0
                ? accumulated !== 0
                : accumulated >=
                    interval + 1e-9
        ) {
            fail(
                `$.world.movementAccumulators[${index}][1]`,
                "accumulated time is outside scheduler range",
            );
        }
    }

    for (
        const interval of
        expectedIntervals
    ) {
        if (
            !accumulatorIntervals.has(
                interval,
            )
        ) {
            fail(
                "$.world.movementAccumulators",
                `missing scheduled interval ${interval}`,
            );
        }
    }

    return true;
}
