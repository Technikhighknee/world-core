import assert from "node:assert/strict";
import test from "node:test";

import {
    computeWorldCoreStateHash,
    computeWorldCoreStateHashes,
    deserializeWorldCore,
    Navigation,
    rerouteJourney,
    serializeWorldCore,
    startJourney,
    stepSimulation,
    stopJourney,
    World,
} from "../src/index.js";

function rng(seed) {
    let state = seed >>> 0;

    return {
        int(max) {
            state =
                (
                    Math.imul(
                        state,
                        1664525,
                    ) +
                    1013904223
                ) >>> 0;

            return state % max;
        },

        float() {
            state =
                (
                    Math.imul(
                        state,
                        1664525,
                    ) +
                    1013904223
                ) >>> 0;

            return (
                state /
                0x100000000
            );
        },

        pick(values) {
            return values[
                this.int(
                    values.length,
                )
            ];
        },
    };
}

function buildGridNavigation(
    size = 4,
    spacing = 20,
) {
    const navigation =
        new Navigation({
            spatialCellSize: 10,
        });

    const nodeId =
        (x, y) => `n-${x}-${y}`;

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            navigation.addNode({
                id: nodeId(x, y),
                x: x * spacing,
                y: y * spacing,
                junctionRadius:
                    (x + y) % 3 === 0
                        ? 1.5
                        : 0,
            });
        }
    }

    let roadSerial = 0;

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            if (x + 1 < size) {
                navigation.addRoad({
                    id:
                        `r-${roadSerial++}`,
                    from:
                        nodeId(x, y),
                    to:
                        nodeId(
                            x + 1,
                            y,
                        ),
                    width: 4,
                });
            }

            if (y + 1 < size) {
                navigation.addRoad({
                    id:
                        `r-${roadSerial++}`,
                    from:
                        nodeId(x, y),
                    to:
                        nodeId(
                            x,
                            y + 1,
                        ),
                    width: 4,
                });
            }
        }
    }

    return {
        navigation,
        nodeIds:
            [...navigation.nodes.keys()],
        nextRoadSerial:
            roadSerial,
    };
}

function assertRouteValid(
    navigation,
    route,
    mobility,
) {
    if (!route) return;

    assert.ok(
        Number.isFinite(
            route.estimatedSeconds,
        ),
    );
    assert.ok(
        route.estimatedSeconds >= 0,
    );

    for (const leg of route.legs) {
        assert.equal(
            navigation.isRouteLegCurrent(
                leg,
                mobility,
            ),
            true,
        );
    }
}

test("randomized navigation mutations preserve invariants and valid routes", () => {
    for (
        const seed of
        [1, 7, 41, 99, 31337]
    ) {
        const random = rng(seed);
        const built =
            buildGridNavigation();
        const navigation =
            built.navigation;
        const nodeIds =
            built.nodeIds;
        let nextRoadSerial =
            built.nextRoadSerial;

        const mobilities = [
            {
                profileId:
                    "fuzz-walker",
                speed: 1.2,
            },
            {
                profileId:
                    "fuzz-cart",
                speed: 0.9,
                requiredRoadWidth: 2,
            },
        ];

        for (
            let operation = 0;
            operation < 300;
            operation++
        ) {
            const roadIds =
                [...navigation.roads.keys()];
            const op =
                random.int(11);

            if (
                op === 0 &&
                navigation.roads.size <
                    60
            ) {
                const from =
                    random.pick(
                        nodeIds,
                    );
                let to =
                    random.pick(
                        nodeIds,
                    );

                if (to === from) {
                    to =
                        nodeIds[
                            (
                                nodeIds.indexOf(
                                    from,
                                ) +
                                1
                            ) %
                            nodeIds.length
                        ];
                }

                navigation.addRoad({
                    id:
                        `fuzz-road-${nextRoadSerial++}`,
                    from,
                    to,
                    width:
                        2 +
                        random.int(5),
                    surface:
                        random.int(3) ===
                        0
                            ? "mud"
                            : "street",
                    bidirectional:
                        random.int(4) !==
                        0,
                });
            } else if (
                op === 1 &&
                roadIds.length > 8
            ) {
                navigation.removeRoad(
                    random.pick(
                        roadIds,
                    ),
                );
            } else if (
                op === 2 &&
                roadIds.length > 0
            ) {
                const roadId =
                    random.pick(
                        roadIds,
                    );
                const road =
                    navigation.roads.get(
                        roadId,
                    );

                navigation.setRoadEnabled(
                    roadId,
                    !road.enabled,
                );
            } else if (
                op === 3 &&
                roadIds.length > 0
            ) {
                navigation.setRoadWidth(
                    random.pick(
                        roadIds,
                    ),
                    1 +
                        random.int(7),
                );
            } else if (
                op === 4 &&
                roadIds.length > 0
            ) {
                navigation.setRoadSurface(
                    random.pick(
                        roadIds,
                    ),
                    random.pick([
                        "street",
                        "mud",
                        "stone",
                    ]),
                );
            } else if (
                op === 5 &&
                roadIds.length > 0
            ) {
                const roadId =
                    random.pick(
                        roadIds,
                    );
                const road =
                    navigation.roads.get(
                        roadId,
                    );

                navigation.setRoadBidirectional(
                    roadId,
                    !road.bidirectional,
                );
            } else if (
                op === 6 &&
                roadIds.length > 0
            ) {
                const roadId =
                    random.pick(
                        roadIds,
                    );

                navigation.setRoadEffect(
                    "fuzz-effect",
                    roadId,
                    {
                        blocked:
                            random.int(5) ===
                            0,
                        costMultiplier:
                            1 +
                            random.int(4),
                    },
                );
            } else if (
                op === 7 &&
                roadIds.length > 0
            ) {
                navigation.clearRoadEffect(
                    "fuzz-effect",
                );
            } else if (
                op === 8 &&
                roadIds.length > 0
            ) {
                const roadId =
                    random.pick(
                        roadIds,
                    );
                const road =
                    navigation.roads.get(
                        roadId,
                    );
                const from =
                    navigation.nodes.get(
                        road.from,
                    ).position;
                const to =
                    navigation.nodes.get(
                        road.to,
                    ).position;

                navigation.replaceRoadGeometry(
                    roadId,
                    [{
                        x:
                            (
                                from.x +
                                to.x
                            ) / 2 +
                            random.int(7) -
                            3,
                        y:
                            (
                                from.y +
                                to.y
                            ) / 2 +
                            random.int(7) -
                            3,
                    }],
                );
            } else if (op === 9) {
                const nodeId =
                    random.pick(
                        nodeIds,
                    );

                navigation.setNodeJunctionRadius(
                    nodeId,
                    random.int(5),
                );
            } else {
                const start =
                    random.pick(
                        nodeIds,
                    );
                const destination =
                    random.pick(
                        nodeIds,
                    );
                const mobility =
                    random.pick(
                        mobilities,
                    );

                const route =
                    navigation.findRoute(
                        start,
                        destination,
                        mobility,
                    );

                assertRouteValid(
                    navigation,
                    route,
                    mobility,
                );
            }

            navigation
                .assertInternalConsistency();
        }
    }
});

function bruteRadius(
    world,
    position,
    radius,
) {
    return [
        ...world.entities.values(),
    ]
        .filter(entity => {
            const dx =
                entity.position.x -
                position.x;
            const dy =
                entity.position.y -
                position.y;
            const bodyRadius =
                entity.body?.radius ??
                0;

            return (
                dx * dx + dy * dy <=
                (
                    radius +
                    bodyRadius
                ) ** 2
            );
        })
        .map(entity => entity.id)
        .sort();
}

test("randomized world movement lifecycle serialization and spatial queries preserve invariants", () => {
    for (
        const seed of
        [5, 17, 101]
    ) {
        const random = rng(seed);
        const built =
            buildGridNavigation(
                4,
                20,
            );

        let navigation =
            built.navigation;
        let world =
            new World({
                spatialCellSize: 5,
                obstacleCellSize: 5,
                localSteering: {
                    neighborRadius: 3,
                    obstacleLookahead: 3,
                    maxLateralSpeed: 1,
                    minSpeedMultiplier:
                        0.2,
                },
            });

        let nextEntityId = 0;
        let nextObstacleId = 0;

        function addRandomEntity() {
            const node =
                navigation.nodes.get(
                    random.pick(
                        built.nodeIds,
                    ),
                );
            const id =
                `entity-${seed}-${nextEntityId++}`;

            world.addEntity({
                id,
                kind: "person",
                position: {
                    ...node.position,
                },
                body: {
                    radius:
                        0.2 +
                        random.int(4) *
                            0.05,
                },
                mobility: {
                    profileId:
                        "fuzz-person",
                    speed:
                        0.8 +
                        random.int(5) *
                            0.1,
                },
            });

            return id;
        }

        for (let i = 0; i < 30; i++) {
            addRandomEntity();
        }

        for (
            let operation = 0;
            operation < 350;
            operation++
        ) {
            const entityIds =
                [...world.entities.keys()];
            const roadIds =
                [...navigation.roads.keys()];
            const obstacleIds =
                [...world.obstacles.obstacles.keys()];
            const op =
                random.int(12);

            if (
                op <= 2 &&
                entityIds.length > 0
            ) {
                const entityId =
                    random.pick(
                        entityIds,
                    );
                const destination =
                    random.pick(
                        built.nodeIds,
                    );

                rerouteJourney(
                    world,
                    navigation,
                    entityId,
                    destination,
                    {
                        entryMaxDistance:
                            10,
                    },
                );
            } else if (
                op === 3 &&
                entityIds.length > 0
            ) {
                const entityId =
                    random.pick(
                        entityIds,
                    );
                const entity =
                    world.getEntity(
                        entityId,
                    );

                stopJourney(
                    entity,
                    world,
                );
            } else if (
                op === 4 &&
                world.entities.size <
                    55
            ) {
                addRandomEntity();
            } else if (
                op === 5 &&
                world.entities.size >
                    15
            ) {
                world.removeEntity(
                    random.pick(
                        entityIds,
                    ),
                );
            } else if (op === 6) {
                const id =
                    `obstacle-${seed}-${nextObstacleId++}`;
                const x =
                    random.int(60);
                const y =
                    random.int(60);

                world.addObstacle({
                    id,
                    type:
                        random.int(2) ===
                        0
                            ? "circle"
                            : "aabb",
                    ...(random.int(2) ===
                    0
                        ? {
                            center: {
                                x,
                                y,
                            },
                            radius:
                                0.5 +
                                random.int(3),
                        }
                        : {
                            minX: x,
                            minY: y,
                            maxX:
                                x +
                                1 +
                                random.int(4),
                            maxY:
                                y +
                                1 +
                                random.int(4),
                        }),
                    temporary: true,
                });
            } else if (
                op === 7 &&
                obstacleIds.length > 0
            ) {
                const id =
                    random.pick(
                        obstacleIds,
                    );

                if (random.int(2) === 0) {
                    world.removeObstacle(
                        id,
                    );
                } else {
                    const obstacle =
                        world.obstacles
                            .obstacles.get(
                                id,
                            );

                    world.setObstacleEnabled(
                        id,
                        !obstacle.enabled,
                    );
                }
            } else if (
                op === 8 &&
                roadIds.length > 0
            ) {
                navigation.setRoadEffect(
                    "fuzz-traffic",
                    random.pick(
                        roadIds,
                    ),
                    {
                        blocked:
                            random.int(6) ===
                            0,
                        costMultiplier:
                            1 +
                            random.int(3),
                    },
                );
            } else if (op === 9) {
                navigation.clearRoadEffect(
                    "fuzz-traffic",
                );
            } else if (op === 10) {
                const position = {
                    x: random.int(61),
                    y: random.int(61),
                };
                const radius =
                    random.int(10);

                assert.deepEqual(
                    world.queryRadius(
                        position,
                        radius,
                    )
                        .map(
                            entity =>
                                entity.id,
                        )
                        .sort(),
                    bruteRadius(
                        world,
                        position,
                        radius,
                    ),
                );
            } else {
                stepSimulation(
                    world,
                    navigation,
                    0.05 +
                        random.int(6) *
                            0.05,
                );
            }

            if (
                operation > 0 &&
                operation % 70 === 0
            ) {
                const before =
                    computeWorldCoreStateHash(
                        world,
                        navigation,
                    );

                const restored =
                    deserializeWorldCore(
                        JSON.parse(
                            JSON.stringify(
                                serializeWorldCore(
                                    world,
                                    navigation,
                                ),
                            ),
                        ),
                    );

                world =
                    restored.world;
                navigation =
                    restored.navigation;

                assert.equal(
                    computeWorldCoreStateHash(
                        world,
                        navigation,
                    ),
                    before,
                );
            }

            world.assertInternalConsistency();
            navigation.assertInternalConsistency();

            for (
                const entity of
                world.entities.values()
            ) {
                assert.ok(
                    Number.isFinite(
                        entity.position.x,
                    ),
                );
                assert.ok(
                    Number.isFinite(
                        entity.position.y,
                    ),
                );
            }
        }
    }
});

test("canonical state hashes ignore object key insertion order and change with semantic state", () => {
    function build(metadata) {
        const navigation =
            new Navigation();

        navigation.addNode({
            id: "a",
            x: 0,
            y: 0,
        });
        navigation.addNode({
            id: "b",
            x: 10,
            y: 0,
        });
        navigation.addRoad({
            id: "road",
            from: "a",
            to: "b",
        });

        const world =
            new World();

        world.addEntity({
            id: "person",
            position: {
                x: 0,
                y: 0,
            },
            metadata,
            mobility: {
                profileId:
                    "hash-person",
                speed: 1,
            },
        });

        return {
            world,
            navigation,
        };
    }

    const one = build({
        first: 1,
        second: 2,
    });
    const two = build({
        second: 2,
        first: 1,
    });

    assert.equal(
        computeWorldCoreStateHash(
            one.world,
            one.navigation,
        ),
        computeWorldCoreStateHash(
            two.world,
            two.navigation,
        ),
    );

    const before =
        computeWorldCoreStateHashes(
            one.world,
            one.navigation,
        );

    one.world.setPosition(
        "person",
        { x: 1, y: 0 },
    );

    const after =
        computeWorldCoreStateHashes(
            one.world,
            one.navigation,
        );

    assert.notEqual(
        before.overall,
        after.overall,
    );
    assert.equal(
        before.navigation,
        after.navigation,
    );
    assert.notEqual(
        before.entities,
        after.entities,
    );
});
