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

export function validateWorldCoreSnapshot(
    snapshot,
    {
        expectedFormat =
            "world-core",
        expectedVersion = 3,
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

    const navigation =
        requireObject(
            snapshot.navigation,
            "$.navigation",
        );

    requirePositive(
        navigation.spatialCellSize,
        "$.navigation.spatialCellSize",
    );
    requireInteger(
        navigation.routeCacheSize,
        "$.navigation.routeCacheSize",
    );
    requireInteger(
        navigation.routeCacheMaxLegs,
        "$.navigation.routeCacheMaxLegs",
    );
    requireInteger(
        navigation.routeCacheMaxTotalLegs,
        "$.navigation.routeCacheMaxTotalLegs",
    );
    requireInteger(
        navigation.hierarchicalRouteCacheSize,
        "$.navigation.hierarchicalRouteCacheSize",
    );
    requireInteger(
        navigation.regionalRouteCacheSize,
        "$.navigation.regionalRouteCacheSize",
    );

    const regions =
        requireArray(
            navigation.regions ?? [],
            "$.navigation.regions",
        );

    const regionIds =
        requireUniqueIds(
            regions,
            "$.navigation.regions",
            region => {
                requireObject(
                    region,
                    "$.navigation.regions[]",
                );

                if (
                    typeof region.id !==
                        "string" ||
                    region.id.length === 0
                ) {
                    fail(
                        "$.navigation.regions[].id",
                        "expected non-empty string",
                    );
                }

                return region.id;
            },
        );

    const nodes =
        requireArray(
            navigation.nodes,
            "$.navigation.nodes",
        );
    const nodeIds =
        requireUniqueIds(
            nodes,
            "$.navigation.nodes",
            node => {
                requireObject(
                    node,
                    "$.navigation.nodes[]",
                );
                return requireId(
                    node.id,
                    "$.navigation.nodes[].id",
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
        const path =
            `$.navigation.nodes[${index}]`;

        requireFinite(
            node.x,
            `${path}.x`,
        );
        requireFinite(
            node.y,
            `${path}.y`,
        );
        requireNonNegative(
            node.junctionRadius ?? 0,
            `${path}.junctionRadius`,
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
                `${path}.regionId`,
                "references missing navigation region",
            );
        }
    }

    const roads =
        requireArray(
            navigation.roads,
            "$.navigation.roads",
        );
    const roadIds =
        requireUniqueIds(
            roads,
            "$.navigation.roads",
            road => {
                requireObject(
                    road,
                    "$.navigation.roads[]",
                );
                return requireId(
                    road.id,
                    "$.navigation.roads[].id",
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
        const path =
            `$.navigation.roads[${index}]`;

        if (
            !nodeIds.has(
                nodeKey(road.from),
            )
        ) {
            fail(
                `${path}.from`,
                "references missing node",
            );
        }

        if (
            !nodeIds.has(
                nodeKey(road.to),
            )
        ) {
            fail(
                `${path}.to`,
                "references missing node",
            );
        }

        requirePositive(
            road.width,
            `${path}.width`,
        );

        if (
            typeof road.surface !==
            "string"
        ) {
            fail(
                `${path}.surface`,
                "expected string",
            );
        }

        requireBoolean(
            road.bidirectional,
            `${path}.bidirectional`,
        );
        requireBoolean(
            road.enabled,
            `${path}.enabled`,
        );

        validateStringArray(
            road.allowedProfiles,
            `${path}.allowedProfiles`,
            {
                nullable: true,
            },
        );
        validateStringArray(
            road.blockedProfiles ?? [],
            `${path}.blockedProfiles`,
        );
        validateStringArray(
            road.tags ?? [],
            `${path}.tags`,
        );

        const shape =
            requireArray(
                road.shape,
                `${path}.shape`,
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
            `${path}.version`,
            1,
        );

        const effects =
            requireArray(
                road.effects ?? [],
                `${path}.effects`,
            );

        requireUniqueIds(
            effects,
            `${path}.effects`,
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

    for (
        let index = 0;
        index < routes.length;
        index++
    ) {
        const route =
            routes[index];
        const path =
            `$.routes[${index}]`;

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

        if (
            entity.body?.radius !==
            undefined
        ) {
            requireNonNegative(
                entity.body.radius,
                `${path}.entity.body.radius`,
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

            requireInteger(
                journey.legIndex,
                `${path}.journey.legIndex`,
            );
            requireInteger(
                journey.pointIndex,
                `${path}.journey.pointIndex`,
            );

            if (
                journey.entryPoint !==
                null
            ) {
                requirePoint(
                    journey.entryPoint,
                    `${path}.journey.entryPoint`,
                );
            }

            if (
                journey.prefixLeg !==
                null
            ) {
                const prefix =
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

    const accumulators =
        requireArray(
            world.movementAccumulators ?? [],
            "$.world.movementAccumulators",
        );

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

        requireNonNegative(
            pair[0],
            `$.world.movementAccumulators[${index}][0]`,
        );
        requireNonNegative(
            pair[1],
            `$.world.movementAccumulators[${index}][1]`,
        );
    }

    return true;
}
