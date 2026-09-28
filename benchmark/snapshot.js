import { performance } from "node:perf_hooks";

import {
    computeWorldCoreStateHash,
    deserializeWorldCore,
    serializeWorldCore,
    validateWorldCoreSnapshot,
} from "../src/index.js";
import { mobilityProfile } from "../src/world/mobility-profiles.js";
import { startJourney } from "../src/world/movement.js";
import { World } from "../src/world/world.js";
import {
    forceGc,
    mib,
    printMemoryDelta,
    printMemorySample,
} from "./support/metrics.js";
import {
    buildCityNavigation,
    cityOriginX,
    nodeId,
} from "./support/scenario.js";

const cityCount = Number(
    process.env.SNAPSHOT_CITIES ?? 20,
);
const gridSize = Number(
    process.env.SNAPSHOT_GRID_SIZE ?? 20,
);
const nodeSpacing = Number(
    process.env.SNAPSHOT_NODE_SPACING ?? 50,
);
const citySpacing = Number(
    process.env.SNAPSHOT_CITY_SPACING ?? 10000,
);
const totalEntities = Number(
    process.env.SNAPSHOT_ENTITIES ?? 50000,
);
const targetMovers = Number(
    process.env.SNAPSHOT_MOVERS ?? 20000,
);

if (
    !(totalEntities > 0) ||
    !(targetMovers >= 0) ||
    targetMovers > totalEntities
) {
    throw new Error(
        "Invalid snapshot benchmark entity/mover counts",
    );
}

const forcedGcSamples = [];
const pedestrian =
    mobilityProfile("pedestrian");

const startup =
    await forceGc(
        "startup post-GC",
        forcedGcSamples,
    );

const {
    navigation,
    buildMs,
} = buildCityNavigation({
    cityCount,
    gridSize,
    nodeSpacing,
    citySpacing,
    routeCacheSize: 20000,
    routeCacheMaxLegs: 256,
    routeCacheMaxTotalLegs: 100000,
});

const world = new World({
    spatialCellSize: 10,
    obstacleCellSize: 20,
});

for (let i = 0; i < 200; i++) {
    const city =
        i % cityCount;
    const originX =
        cityOriginX(
            city,
            citySpacing,
        );

    world.addObstacle({
        id: `obstacle-${i}`,
        type:
            i % 2 === 0
                ? "circle"
                : "aabb",
        ...(i % 2 === 0
            ? {
                center: {
                    x:
                        originX +
                        150 +
                        (i % 20) * 10,
                    y:
                        150 +
                        (i % 10) * 10,
                },
                radius:
                    0.5 +
                    (i % 4) * 0.25,
            }
            : {
                minX:
                    originX +
                    200 +
                    (i % 20) * 10,
                minY:
                    200 +
                    (i % 10) * 10,
                maxX:
                    originX +
                    203 +
                    (i % 20) * 10,
                maxY:
                    203 +
                    (i % 10) * 10,
            }),
        temporary:
            i % 3 === 0,
    });
}

let moversCreated = 0;

for (
    let i = 0;
    i < totalEntities;
    i++
) {
    const city =
        i % cityCount;
    const originX =
        cityOriginX(
            city,
            citySpacing,
        );
    const moving =
        moversCreated <
        targetMovers;
    const entityId =
        `person-${String(i).padStart(6, "0")}`;

    world.addEntity({
        id: entityId,
        kind: "person",
        position: moving
            ? {
                x: originX,
                y: 0,
            }
            : {
                x:
                    originX +
                    100 +
                    (i % 100),
                y:
                    100 +
                    Math.floor(
                        i / 100,
                    ) % 400,
            },
        body: {
            radius:
                0.3 +
                (i % 4) * 0.02,
        },
        mobility:
            pedestrian,
        metadata: {
            household:
                i % 10000,
            occupation:
                `occupation-${i % 32}`,
        },
    });

    if (moving) {
        startJourney(
            world,
            navigation,
            entityId,
            nodeId(
                city,
                gridSize - 1,
                gridSize - 1,
            ),
        );
        moversCreated++;
    }
}

if (
    world.entities.size !==
    totalEntities
) {
    throw new Error(
        "Snapshot benchmark entity count mismatch",
    );
}

if (
    world.movingEntities.size !==
    targetMovers
) {
    throw new Error(
        "Snapshot benchmark mover count mismatch",
    );
}

navigation.setRoadEffect(
    "snapshot-traffic",
    "city-0-h-0-0",
    {
        costMultiplier: 1.5,
    },
);

world.time = 98765.5;

const baselineHashStarted =
    performance.now();
const baselineHash =
    computeWorldCoreStateHash(
        world,
        navigation,
    );
const baselineHashMs =
    performance.now() -
    baselineHashStarted;

const builtMemory =
    await forceGc(
        "built world post-GC",
        forcedGcSamples,
    );

let snapshot = null;
let json = null;
let parsed = null;
let restored = null;

const serializeStarted =
    performance.now();
snapshot =
    serializeWorldCore(
        world,
        navigation,
    );
const serializeMs =
    performance.now() -
    serializeStarted;

const snapshotMemory =
    await forceGc(
        "snapshot object post-GC",
        forcedGcSamples,
    );

const stringifyStarted =
    performance.now();
json = JSON.stringify(snapshot);
const stringifyMs =
    performance.now() -
    stringifyStarted;
const jsonBytes =
    Buffer.byteLength(
        json,
        "utf8",
    );

const jsonMemory =
    await forceGc(
        "JSON string post-GC",
        forcedGcSamples,
    );

const parseStarted =
    performance.now();
parsed = JSON.parse(json);
const parseMs =
    performance.now() -
    parseStarted;

const parsedMemory =
    await forceGc(
        "parsed JSON post-GC",
        forcedGcSamples,
    );

const validateStarted =
    performance.now();
validateWorldCoreSnapshot(
    parsed,
);
const validateMs =
    performance.now() -
    validateStarted;

const restoreStarted =
    performance.now();
restored =
    deserializeWorldCore(
        parsed,
    );
const restoreMs =
    performance.now() -
    restoreStarted;

const restoredMemory =
    await forceGc(
        "restored world post-GC",
        forcedGcSamples,
    );

const restoredHashStarted =
    performance.now();
const restoredHash =
    computeWorldCoreStateHash(
        restored.world,
        restored.navigation,
    );
const restoredHashMs =
    performance.now() -
    restoredHashStarted;

if (
    baselineHash !==
    restoredHash
) {
    throw new Error(
        "Snapshot benchmark restored state hash mismatch",
    );
}

console.log(
    "=== snapshot workload ===",
);
console.log(
    `cities: ${cityCount.toLocaleString()}`,
);
console.log(
    `nodes: ${navigation.nodes.size.toLocaleString()}`,
);
console.log(
    `roads: ${navigation.roads.size.toLocaleString()}`,
);
console.log(
    `graph build: ${buildMs.toFixed(2)} ms`,
);
console.log(
    `entities: ${world.entities.size.toLocaleString()}`,
);
console.log(
    `active movers: ${world.movingEntities.size.toLocaleString()}`,
);
console.log(
    `obstacles: ${world.obstacles.obstacles.size.toLocaleString()}`,
);

console.log(
    "\n=== snapshot timings ===",
);
console.log(
    `serialize object: ${serializeMs.toFixed(2)} ms`,
);
console.log(
    `JSON.stringify: ${stringifyMs.toFixed(2)} ms`,
);
console.log(
    `JSON.parse: ${parseMs.toFixed(2)} ms`,
);
console.log(
    `validate: ${validateMs.toFixed(2)} ms`,
);
console.log(
    `deserialize: ${restoreMs.toFixed(2)} ms`,
);
console.log(
    `baseline state hash: ${baselineHashMs.toFixed(2)} ms`,
);
console.log(
    `restored state hash: ${restoredHashMs.toFixed(2)} ms`,
);

console.log(
    "\n=== snapshot size ===",
);
console.log(
    `JSON bytes: ${jsonBytes.toLocaleString()}`,
);
console.log(
    `JSON MiB: ${mib(jsonBytes).toFixed(2)}`,
);
console.log(
    `bytes/entity: ${(jsonBytes / totalEntities).toFixed(1)}`,
);

console.log(
    "\n=== retained memory phases ===",
);
printMemorySample(startup);
printMemorySample(builtMemory);
printMemorySample(snapshotMemory);
printMemorySample(jsonMemory);
printMemorySample(parsedMemory);
printMemorySample(restoredMemory);

printMemoryDelta(
    "world retained",
    startup,
    builtMemory,
);
printMemoryDelta(
    "snapshot object retained",
    builtMemory,
    snapshotMemory,
);
printMemoryDelta(
    "JSON string retained",
    snapshotMemory,
    jsonMemory,
);
printMemoryDelta(
    "parsed object retained",
    jsonMemory,
    parsedMemory,
);
printMemoryDelta(
    "restored world retained",
    parsedMemory,
    restoredMemory,
);

console.log(
    `state hash: ${restoredHash}`,
);
