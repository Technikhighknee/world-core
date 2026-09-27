import { performance } from "node:perf_hooks";

import { mobilityProfile } from "../src/world/mobility-profiles.js";
import {
    rerouteJourney,
    startJourney,
    stopJourney,
} from "../src/world/movement.js";
import { stepSimulation } from "../src/world/simulation.js";
import { World } from "../src/world/world.js";
import {
    attachGcToTicks,
    forceGc,
    GcMonitor,
    printDurationSummary,
    printForcedGc,
    printMemoryDelta,
    printMemorySample,
    printWorstTicks,
    sampleMemory,
    withoutForcedGc,
} from "./support/metrics.js";
import {
    buildCityNavigation,
    cityOriginX,
    createRng,
    nodeId,
} from "./support/scenario.js";

const cityCount = Number(process.env.CHURN_CITIES ?? 20);
const gridSize = Number(process.env.CHURN_GRID_SIZE ?? 20);
const nodeSpacing = Number(process.env.CHURN_NODE_SPACING ?? 50);
const citySpacing = Number(process.env.CHURN_CITY_SPACING ?? 10000);
const totalEntities = Number(process.env.CHURN_ENTITIES ?? 50000);
const targetMovers = Number(process.env.CHURN_MOVERS ?? 20000);
const ticks = Number(process.env.CHURN_TICKS ?? 1000);

const reroutesPerTick = Number(process.env.CHURN_REROUTES_PER_TICK ?? 100);
const stopStartsPerTick = Number(process.env.CHURN_STOP_STARTS_PER_TICK ?? 100);
const moverReplacementsPerTick = Number(
    process.env.CHURN_MOVER_REPLACEMENTS_PER_TICK ?? 25,
);
const idleReplacementsPerTick = Number(
    process.env.CHURN_IDLE_REPLACEMENTS_PER_TICK ?? 25,
);

const memorySampleEvery = Number(
    process.env.CHURN_MEMORY_SAMPLE_EVERY ?? 10,
);
const retentionCheckEvery = Number(
    process.env.CHURN_RETENTION_CHECK_EVERY ?? 250,
);

if (targetMovers > totalEntities) {
    throw new Error("CHURN_MOVERS cannot exceed CHURN_ENTITIES");
}

const pedestrian = mobilityProfile("pedestrian");
const rng = createRng(0x51f15e);
const forcedGcSamples = [];
const gcMonitor = new GcMonitor();

const startup = await forceGc("startup post-GC", forcedGcSamples);

const {
    navigation,
    buildMs: graphBuildElapsed,
} = buildCityNavigation({
    cityCount,
    gridSize,
    nodeSpacing,
    citySpacing,
    routeCacheSize: 20000,
    routeCacheMaxLegs: 256,
    routeCacheMaxTotalLegs: 100000,
});

const afterGraph = await forceGc("graph post-GC", forcedGcSamples);

const world = new World({ spatialCellSize: 10 });
const moverIds = new Array(targetMovers);
const idleIds = new Array(totalEntities - targetMovers);

let nextEntitySerial = totalEntities;

function cityForIndex(index) {
    return index % cityCount;
}

function farCornerNode(city, fromX, fromY) {
    const midpoint = (gridSize - 1) / 2;
    const targetX = fromX <= midpoint ? gridSize - 1 : 0;
    const targetY = fromY <= midpoint ? gridSize - 1 : 0;

    return nodeId(city, targetX, targetY);
}

function startMoverFromNode(entityId, city, x, y) {
    const destination = farCornerNode(city, x, y);

    if (!startJourney(world, navigation, entityId, destination)) {
        throw new Error(`Failed to start mover ${entityId}`);
    }

    if (!world.getEntity(entityId).journey) {
        throw new Error(`Mover ${entityId} received an empty journey`);
    }
}

function addMover(entityId, city, x = 0, y = 0) {
    const originX = cityOriginX(city, citySpacing);

    world.addEntity({
        id: entityId,
        kind: "person",
        position: {
            x: originX + x * nodeSpacing,
            y: y * nodeSpacing,
        },
        mobility: pedestrian,
    });

    startMoverFromNode(entityId, city, x, y);
}

function addIdle(entityId, city, offset) {
    const originX = cityOriginX(city, citySpacing);

    world.addEntity({
        id: entityId,
        kind: "person",
        position: {
            x: originX + 100 + (offset % 100),
            y: 100 + Math.floor(offset / 100),
        },
        mobility: pedestrian,
    });
}

function randomDestination(city) {
    return nodeId(
        city,
        rng.nextInt(gridSize),
        rng.nextInt(gridSize),
    );
}

function ensureMoving(entityId, city) {
    const entity = world.getEntity(entityId);

    if (!entity) {
        throw new Error(`Missing mover ${entityId}`);
    }

    if (entity.journey) return;

    const node = navigation.nodeAt(entity.position, 0.1);

    if (node) {
        const localX = Math.round(
            (node.position.x - cityOriginX(city, citySpacing)) /
            nodeSpacing,
        );
        const localY = Math.round(node.position.y / nodeSpacing);

        startMoverFromNode(entityId, city, localX, localY);
        return;
    }

    for (let attempt = 0; attempt < 8; attempt++) {
        const destination = randomDestination(city);

        if (
            rerouteJourney(
                world,
                navigation,
                entityId,
                destination,
            ) &&
            world.getEntity(entityId).journey
        ) {
            return;
        }
    }

    throw new Error(`Failed to restore active journey for ${entityId}`);
}

for (let i = 0; i < targetMovers; i++) {
    const city = cityForIndex(i);
    const entityId = `mover-${i}`;

    moverIds[i] = entityId;
    addMover(entityId, city);
}

for (let i = 0; i < idleIds.length; i++) {
    const city = cityForIndex(i);
    const entityId = `idle-${i}`;

    idleIds[i] = entityId;
    addIdle(entityId, city, i);
}

if (world.entities.size !== totalEntities) {
    throw new Error("Initial entity count mismatch");
}

if (world.movingEntities.size !== targetMovers) {
    throw new Error("Initial mover count mismatch");
}

const afterPopulation = await forceGc(
    "population post-GC",
    forcedGcSamples,
);

const simulationTicks = [];
const maintenanceDurations = [];
const totalLoopDurations = [];
const memorySamples = [afterPopulation];
const retainedCheckpoints = [afterPopulation];

let totalReroutes = 0;
let totalStopStarts = 0;
let totalMoverReplacements = 0;
let totalIdleReplacements = 0;
let totalCompletedRestarts = 0;
let minMoversAfterMaintenance = world.movingEntities.size;
let maxMoversAfterMaintenance = world.movingEntities.size;

for (let tick = 1; tick <= ticks; tick++) {
    const loopStarted = performance.now();
    const simulationStarted = performance.now();

    stepSimulation(world, navigation, 1);

    const simulationEnded = performance.now();

    simulationTicks.push({
        tick,
        startTime: simulationStarted,
        endTime: simulationEnded,
        duration: simulationEnded - simulationStarted,
        movers: world.movingEntities.size,
    });

    const maintenanceStarted = performance.now();

    for (let i = 0; i < reroutesPerTick; i++) {
        const moverIndex = rng.nextInt(moverIds.length);
        const entityId = moverIds[moverIndex];
        const city = cityForIndex(moverIndex);

        if (
            rerouteJourney(
                world,
                navigation,
                entityId,
                randomDestination(city),
            )
        ) {
            totalReroutes++;
        }

        ensureMoving(entityId, city);
    }

    for (let i = 0; i < stopStartsPerTick; i++) {
        const moverIndex = rng.nextInt(moverIds.length);
        const entityId = moverIds[moverIndex];
        const city = cityForIndex(moverIndex);
        const entity = world.getEntity(entityId);

        stopJourney(entity, world);
        totalStopStarts++;

        for (let attempt = 0; attempt < 8; attempt++) {
            if (
                startJourney(
                    world,
                    navigation,
                    entityId,
                    randomDestination(city),
                ) &&
                world.getEntity(entityId).journey
            ) {
                break;
            }
        }

        ensureMoving(entityId, city);
    }

    for (let i = 0; i < moverReplacementsPerTick; i++) {
        const moverIndex = rng.nextInt(moverIds.length);
        const oldId = moverIds[moverIndex];
        const city = cityForIndex(moverIndex);

        world.removeEntity(oldId);

        const newId = `mover-churn-${nextEntitySerial++}`;
        moverIds[moverIndex] = newId;

        addMover(newId, city);
        totalMoverReplacements++;
    }

    for (let i = 0; i < idleReplacementsPerTick; i++) {
        const idleIndex = rng.nextInt(idleIds.length);
        const oldId = idleIds[idleIndex];
        const city = cityForIndex(idleIndex);

        world.removeEntity(oldId);

        const newId = `idle-churn-${nextEntitySerial++}`;
        idleIds[idleIndex] = newId;

        addIdle(newId, city, nextEntitySerial);
        totalIdleReplacements++;
    }

    for (let i = 0; i < moverIds.length; i++) {
        const entityId = moverIds[i];
        const entity = world.getEntity(entityId);

        if (!entity.journey) {
            ensureMoving(entityId, cityForIndex(i));
            totalCompletedRestarts++;
        }
    }

    if (world.entities.size !== totalEntities) {
        throw new Error(
            `Entity count drift at tick ${tick}: ${world.entities.size}`,
        );
    }

    if (world.movingEntities.size !== targetMovers) {
        throw new Error(
            `Mover count drift at tick ${tick}: ${world.movingEntities.size}`,
        );
    }

    minMoversAfterMaintenance = Math.min(
        minMoversAfterMaintenance,
        world.movingEntities.size,
    );
    maxMoversAfterMaintenance = Math.max(
        maxMoversAfterMaintenance,
        world.movingEntities.size,
    );

    const maintenanceEnded = performance.now();
    maintenanceDurations.push(maintenanceEnded - maintenanceStarted);
    totalLoopDurations.push(maintenanceEnded - loopStarted);

    if (tick % memorySampleEvery === 0 || tick === ticks) {
        memorySamples.push(sampleMemory(`tick ${tick}`, tick));
        await gcMonitor.flush();
    }

    if (
        retentionCheckEvery > 0 &&
        tick % retentionCheckEvery === 0
    ) {
        retainedCheckpoints.push(
            await forceGc(
                `retention checkpoint ${tick}`,
                forcedGcSamples,
            ),
        );
        await gcMonitor.flush();
    }
}

const beforeFinalGc = sampleMemory("run end before GC", ticks);
const afterFinalGc = await forceGc(
    "run end post-GC",
    forcedGcSamples,
);

retainedCheckpoints.push(afterFinalGc);

await gcMonitor.flush();

const routeCacheSizeBeforeClear = navigation.routeCache.size;
const routeCacheLegsBeforeClear = navigation.routeCacheLegCount;

navigation.invalidateAllRoutes();

const afterCacheClear = await forceGc(
    "route cache cleared post-GC",
    forcedGcSamples,
);

for (const entityId of world.entities.keys()) {
    world.removeEntity(entityId);
}

const afterEntityClear = await forceGc(
    "entities cleared post-GC",
    forcedGcSamples,
);

await gcMonitor.flush();
gcMonitor.stop();

const automaticGcEvents = withoutForcedGc(
    gcMonitor.events,
    forcedGcSamples,
);

attachGcToTicks(simulationTicks, automaticGcEvents);

const simulationDurations = simulationTicks.map(
    sample => sample.duration,
);
const automaticGcDurations = automaticGcEvents.map(
    event => event.duration,
);

const peakHeap = Math.max(
    ...memorySamples.map(sample => sample.heapUsed),
    beforeFinalGc.heapUsed,
);
const peakRss = Math.max(
    ...memorySamples.map(sample => sample.rss),
    beforeFinalGc.rss,
);

console.log("=== constant-load churn workload ===");
console.log(`cities: ${cityCount}`);
console.log(`nodes: ${navigation.nodes.size.toLocaleString()}`);
console.log(`roads: ${navigation.roads.size.toLocaleString()}`);
console.log(`graph build: ${graphBuildElapsed.toFixed(2)} ms`);
console.log(`ticks: ${ticks.toLocaleString()}`);
console.log(`entities maintained: ${totalEntities.toLocaleString()}`);
console.log(`movers maintained: ${targetMovers.toLocaleString()}`);
console.log(
    `movers after maintenance min/max: ${minMoversAfterMaintenance.toLocaleString()}/${maxMoversAfterMaintenance.toLocaleString()}`,
);
console.log(`reroutes: ${totalReroutes.toLocaleString()}`);
console.log(`stop/start cycles: ${totalStopStarts.toLocaleString()}`);
console.log(
    `mover create/delete replacements: ${totalMoverReplacements.toLocaleString()}`,
);
console.log(
    `idle create/delete replacements: ${totalIdleReplacements.toLocaleString()}`,
);
console.log(
    `completed journey restarts: ${totalCompletedRestarts.toLocaleString()}`,
);
console.log(
    `route cache before clear: ${routeCacheSizeBeforeClear.toLocaleString()} routes / ${routeCacheLegsBeforeClear.toLocaleString()} legs`,
);

console.log("\n=== simulation tick latency ===");
printDurationSummary("simulation tick", simulationDurations);
printWorstTicks(simulationTicks, 10);

console.log("\n=== churn maintenance latency ===");
printDurationSummary("maintenance", maintenanceDurations);
printDurationSummary("full loop", totalLoopDurations);

console.log("\n=== retained-memory checkpoints ===");
for (const sample of retainedCheckpoints) {
    printMemorySample(sample);
}

console.log("\n=== final memory decomposition ===");
printMemorySample(startup);
printMemorySample(afterGraph);
printMemorySample(afterPopulation);
printMemorySample(beforeFinalGc);
printMemorySample(afterFinalGc);
printMemorySample(afterCacheClear);
printMemorySample(afterEntityClear);
console.log(
    `sampled heap peak: ${(peakHeap / 1024 / 1024).toFixed(2)} MiB`,
);
console.log(
    `sampled RSS peak: ${(peakRss / 1024 / 1024).toFixed(2)} MiB`,
);
printMemoryDelta(
    "collectible garbage at end",
    afterFinalGc,
    beforeFinalGc,
);
printMemoryDelta(
    "retained drift vs pre-run population",
    afterPopulation,
    afterFinalGc,
);
printMemoryDelta(
    "cache contribution after run",
    afterCacheClear,
    afterFinalGc,
);
printMemoryDelta(
    "entity/world contribution after cache clear",
    afterEntityClear,
    afterCacheClear,
);

console.log("\n=== GC ===");
console.log(
    `observed automatic GC events: ${automaticGcEvents.length.toLocaleString()}`,
);
printDurationSummary("automatic GC", automaticGcDurations);
printForcedGc(forcedGcSamples);
