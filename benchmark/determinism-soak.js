import { performance } from "node:perf_hooks";

import {
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

const ticks = Number(
    process.env.DETERMINISM_TICKS ??
    10000,
);
const entityCount = Number(
    process.env.DETERMINISM_ENTITIES ??
    200,
);
const hashEvery = Number(
    process.env.DETERMINISM_HASH_EVERY ??
    100,
);
const deltaSeconds = Number(
    process.env.DETERMINISM_DELTA_SECONDS ??
    0.1,
);
const saveTick = Number(
    process.env.DETERMINISM_SAVE_TICK ??
    Math.floor(ticks / 2),
);
const seed = Number(
    process.env.DETERMINISM_SEED ??
    0x5eed1234,
);

function createRng(initialSeed) {
    let state =
        initialSeed >>> 0;

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

        shuffle(values) {
            const copy =
                [...values];

            for (
                let i =
                    copy.length - 1;
                i > 0;
                i--
            ) {
                const j =
                    this.int(i + 1);

                [
                    copy[i],
                    copy[j],
                ] = [
                    copy[j],
                    copy[i],
                ];
            }

            return copy;
        },
    };
}

function buildScenario(
    scenarioSeed,
) {
    const random =
        createRng(
            scenarioSeed,
        );
    const navigation =
        new Navigation({
            spatialCellSize: 10,
        });
    const size = 6;
    const spacing = 20;
    const nodeIds = [];

    function nodeId(x, y) {
        return `n-${x}-${y}`;
    }

    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const id =
                nodeId(x, y);

            nodeIds.push(id);

            navigation.addNode({
                id,
                x:
                    x * spacing,
                y:
                    y * spacing,
                junctionRadius:
                    (x + y) % 4 ===
                    0
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
                    width:
                        4 +
                        (
                            roadSerial %
                            2
                        ),
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
                    width:
                        4 +
                        (
                            roadSerial %
                            2
                        ),
                });
            }
        }
    }

    const roadIds =
        [...navigation.roads.keys()];

    const world =
        new World({
            spatialCellSize: 4,
            obstacleCellSize: 5,
            localSteering: {
                neighborRadius: 3,
                obstacleLookahead: 3,
                separationStrength:
                    0.8,
                maxLateralSpeed:
                    0.9,
                centeringRate:
                    0.35,
                counterflowStrength:
                    0.9,
                minSpeedMultiplier:
                    0.2,
            },
        });

    const obstacleIds = [];

    for (let i = 0; i < 12; i++) {
        const id =
            `obstacle-${String(i).padStart(2, "0")}`;
        obstacleIds.push(id);

        world.addObstacle({
            id,
            type: "circle",
            center: {
                x:
                    10 +
                    random.int(
                        (size - 1) *
                        spacing -
                        20,
                    ),
                y:
                    10 +
                    random.int(
                        (size - 1) *
                        spacing -
                        20,
                    ),
            },
            radius:
                0.4 +
                random.int(4) *
                    0.15,
            temporary:
                i % 2 === 0,
        });
    }

    const entityIds =
        Array.from(
            {
                length:
                    entityCount,
            },
            (_, index) =>
                `person-${String(index).padStart(5, "0")}`,
        );

    const insertionOrder =
        random.shuffle(
            entityIds,
        );

    for (const id of insertionOrder) {
        const start =
            random.int(
                nodeIds.length,
            );
        let destination =
            random.int(
                nodeIds.length,
            );

        if (
            destination ===
            start
        ) {
            destination =
                (
                    destination + 1
                ) %
                nodeIds.length;
        }

        const node =
            navigation.nodes.get(
                nodeIds[start],
            );

        world.addEntity({
            id,
            kind: "person",
            position: {
                ...node.position,
            },
            body: {
                radius:
                    0.25 +
                    random.int(4) *
                        0.04,
            },
            mobility: {
                profileId:
                    "determinism-person",
                speed:
                    0.9 +
                    random.int(5) *
                        0.08,
            },
        });

        startJourney(
            world,
            navigation,
            id,
            nodeIds[
                destination
            ],
        );
    }

    return {
        world,
        navigation,
        nodeIds,
        roadIds,
        obstacleIds,
        entityIds,
    };
}

function applyActions(
    state,
    action,
) {
    const {
        world,
        navigation,
    } = state;

    if (action.reroute) {
        rerouteJourney(
            world,
            navigation,
            action.reroute.entityId,
            action.reroute.destination,
            {
                entryMaxDistance:
                    10,
            },
        );
    }

    if (action.trafficEffect) {
        navigation.clearRoadEffect(
            "det-traffic",
        );

        navigation.setRoadEffect(
            "det-traffic",
            action.trafficEffect.roadId,
            {
                costMultiplier:
                    action.trafficEffect.multiplier,
            },
        );
    }

    if (action.closure) {
        navigation.clearRoadEffect(
            "det-closure",
        );

        navigation.setRoadEffect(
            "det-closure",
            action.closure.roadId,
            {
                blocked: true,
            },
        );
    }

    if (action.clearClosure) {
        navigation.clearRoadEffect(
            "det-closure",
        );
    }

    if (action.obstacleToggle) {
        const obstacle =
            world.obstacles.obstacles.get(
                action.obstacleToggle,
            );

        world.setObstacleEnabled(
            obstacle.id,
            !obstacle.enabled,
        );
    }

    if (action.junction) {
        navigation.setNodeJunctionRadius(
            action.junction.nodeId,
            action.junction.radius,
        );
    }

    if (action.geometry) {
        const road =
            navigation.roads.get(
                action.geometry.roadId,
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
            road.id,
            [{
                x:
                    (
                        from.x +
                        to.x
                    ) / 2 +
                    action.geometry.offsetX,
                y:
                    (
                        from.y +
                        to.y
                    ) / 2 +
                    action.geometry.offsetY,
            }],
        );
    }

    if (action.restart) {
        const entity =
            world.getEntity(
                action.restart.entityId,
            );

        stopJourney(
            entity,
            world,
        );

        startJourney(
            world,
            navigation,
            entity.id,
            action.restart.destination,
            {
                entryMaxDistance:
                    10,
            },
        );
    }
}

function makeAction(
    tick,
    random,
    template,
) {
    const action = {};

    if (tick % 17 === 0) {
        action.reroute = {
            entityId:
                template.entityIds[
                    random.int(
                        template.entityIds.length,
                    )
                ],
            destination:
                template.nodeIds[
                    random.int(
                        template.nodeIds.length,
                    )
                ],
        };
    }

    if (tick % 53 === 0) {
        action.trafficEffect = {
            roadId:
                template.roadIds[
                    random.int(
                        template.roadIds.length,
                    )
                ],
            multiplier:
                1.5 +
                random.int(4) *
                    0.5,
        };
    }

    if (tick % 97 === 0) {
        action.closure = {
            roadId:
                template.roadIds[
                    random.int(
                        template.roadIds.length,
                    )
                ],
        };
    }

    if (tick % 149 === 0) {
        action.clearClosure =
            true;
    }

    if (tick % 131 === 0) {
        action.obstacleToggle =
            template.obstacleIds[
                random.int(
                    template.obstacleIds.length,
                )
            ];
    }

    if (tick % 211 === 0) {
        action.junction = {
            nodeId:
                template.nodeIds[
                    random.int(
                        template.nodeIds.length,
                    )
                ],
            radius:
                random.int(5) *
                0.5,
        };
    }

    if (tick % 307 === 0) {
        action.geometry = {
            roadId:
                template.roadIds[
                    random.int(
                        template.roadIds.length,
                    )
                ],
            offsetX:
                random.int(7) -
                3,
            offsetY:
                random.int(7) -
                3,
        };
    }

    if (tick % 401 === 0) {
        action.restart = {
            entityId:
                template.entityIds[
                    random.int(
                        template.entityIds.length,
                    )
                ],
            destination:
                template.nodeIds[
                    random.int(
                        template.nodeIds.length,
                    )
                ],
        };
    }

    return action;
}

function assertSame(
    tick,
    left,
    right,
) {
    const a =
        computeWorldCoreStateHashes(
            left.world,
            left.navigation,
        );
    const b =
        computeWorldCoreStateHashes(
            right.world,
            right.navigation,
        );

    if (a.overall === b.overall) {
        return;
    }

    const differingSections = [
        "navigation",
        "world",
        "entities",
    ].filter(
        key => a[key] !== b[key],
    );

    throw new Error(
        `Determinism mismatch at tick ${tick}: ${differingSections.join(", ")}\nleft=${JSON.stringify(a)}\nright=${JSON.stringify(b)}`,
    );
}

let left =
    buildScenario(seed);
let right =
    buildScenario(seed);

const actionRandom =
    createRng(
        seed ^ 0xa5a5a5a5,
    );

assertSame(
    0,
    left,
    right,
);

const started =
    performance.now();

for (
    let tick = 1;
    tick <= ticks;
    tick++
) {
    const action =
        makeAction(
            tick,
            actionRandom,
            left,
        );

    applyActions(
        left,
        action,
    );
    applyActions(
        right,
        action,
    );

    stepSimulation(
        left.world,
        left.navigation,
        deltaSeconds,
    );
    stepSimulation(
        right.world,
        right.navigation,
        deltaSeconds,
    );

    if (tick === saveTick) {
        const restored =
            deserializeWorldCore(
                JSON.parse(
                    JSON.stringify(
                        serializeWorldCore(
                            right.world,
                            right.navigation,
                        ),
                    ),
                ),
            );

        right = {
            ...right,
            world:
                restored.world,
            navigation:
                restored.navigation,
        };

        assertSame(
            tick,
            left,
            right,
        );
    }

    if (
        tick % hashEvery ===
            0 ||
        tick === ticks
    ) {
        left.world
            .assertInternalConsistency();
        right.world
            .assertInternalConsistency();
        left.navigation
            .assertInternalConsistency();
        right.navigation
            .assertInternalConsistency();

        assertSame(
            tick,
            left,
            right,
        );
    }
}

const elapsed =
    performance.now() - started;
const finalHashes =
    computeWorldCoreStateHashes(
        left.world,
        left.navigation,
    );

console.log("=== determinism soak ===");
console.log(
    `ticks: ${ticks.toLocaleString()}`,
);
console.log(
    `entities: ${entityCount.toLocaleString()}`,
);
console.log(
    `save/restore tick: ${saveTick.toLocaleString()}`,
);
console.log(
    `hash interval: ${hashEvery.toLocaleString()}`,
);
console.log(
    `elapsed: ${elapsed.toFixed(2)} ms`,
);
console.log(
    `overall hash: ${finalHashes.overall}`,
);
console.log(
    `navigation hash: ${finalHashes.navigation}`,
);
console.log(
    `world hash: ${finalHashes.world}`,
);
console.log(
    `entities hash: ${finalHashes.entities}`,
);
