import { performance } from "node:perf_hooks";

import { mobilityProfile } from "../src/world/mobility-profiles.js";
import { startJourney } from "../src/world/movement.js";
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
    createRouteQueries,
    nodeId,
} from "./support/scenario.js";

const cityCount = Number(process.env.BENCH_CITIES ?? 20);
const gridSize = Number(process.env.BENCH_GRID_SIZE ?? 20);
const nodeSpacing = Number(process.env.BENCH_NODE_SPACING ?? 50);
const entitiesPerCity = Number(process.env.BENCH_ENTITIES_PER_CITY ?? 2500);
const moversPerCity = Number(process.env.BENCH_MOVERS_PER_CITY ?? 750);
const ticks = Number(process.env.BENCH_TICKS ?? 300);
const citySpacing = Number(process.env.BENCH_CITY_SPACING ?? 10000);
const routeQueries = Number(process.env.BENCH_ROUTE_QUERIES ?? 2000);
const memorySampleEvery = Number(process.env.BENCH_MEMORY_SAMPLE_EVERY ?? 10);

const pedestrian = mobilityProfile("pedestrian");
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

const queries = createRouteQueries({
    count: routeQueries,
    cityCount,
    gridSize,
});

navigation.invalidateAllRoutes();

const coldRoutingStarted = performance.now();

for (const query of queries) {
    navigation.findRoute(query.from, query.to, pedestrian);
}

const coldRoutingElapsed = performance.now() - coldRoutingStarted;
const warmRoutingStarted = performance.now();

for (const query of queries) {
    navigation.findRoute(query.from, query.to, pedestrian);
}

const warmRoutingElapsed = performance.now() - warmRoutingStarted;
const afterRoutes = await forceGc("routes post-GC", forcedGcSamples);

const world = new World({ spatialCellSize: 10 });

for (let city = 0; city < cityCount; city++) {
    const originX = cityOriginX(city, citySpacing);

    for (let i = 0; i < entitiesPerCity; i++) {
        const entityId = `city-${city}-person-${i}`;
        const moving = i < moversPerCity;

        world.addEntity({
            id: entityId,
            kind: "person",
            position: moving
                ? { x: originX, y: 0 }
                : {
                    x: originX + 100 + (i % 100),
                    y: 100 + Math.floor(i / 100),
                },
            mobility: pedestrian,
        });

        if (moving) {
            startJourney(
                world,
                navigation,
                entityId,
                nodeId(city, gridSize - 1, gridSize - 1),
            );
        }
    }
}

const afterPopulation = await forceGc(
    "population post-GC",
    forcedGcSamples,
);

const tickSamples = [];
const memorySamples = [afterPopulation];

for (let tick = 1; tick <= ticks; tick++) {
    const startTime = performance.now();

    stepSimulation(world, navigation, 1);

    const endTime = performance.now();

    tickSamples.push({
        tick,
        startTime,
        endTime,
        duration: endTime - startTime,
        movers: world.movingEntities.size,
    });

    if (tick % memorySampleEvery === 0 || tick === ticks) {
        memorySamples.push(sampleMemory(`tick ${tick}`, tick));
        await gcMonitor.flush();
    }
}

const queryBuffer = world.createSpatialQueryBuffer();
const thiefPosition = { x: 100, y: 100 };
const queryStarted = performance.now();
let nearbyCount = 0;

for (let i = 0; i < 10000; i++) {
    nearbyCount += world.queryRadiusInto(
        thiefPosition,
        8,
        queryBuffer,
    ).length;
}

const queryElapsed = performance.now() - queryStarted;

await gcMonitor.flush();

const activeMoversAfterRun = world.movingEntities.size;
const beforeFinalGc = sampleMemory("run end before GC", ticks);
const afterFinalGc = await forceGc(
    "run end post-GC",
    forcedGcSamples,
);

await gcMonitor.flush();

let activeJourneys = 0;

for (const entity of world.entities.values()) {
    if (entity.journey) activeJourneys++;
}

const cachedRoutesBeforeClear = navigation.routeCache.size;
const cachedLegsBeforeClear = navigation.routeCacheLegCount;

navigation.invalidateAllRoutes();

const afterCacheClear = await forceGc(
    "route cache cleared post-GC",
    forcedGcSamples,
);

queryBuffer.results.length = 0;
queryBuffer.candidates.clear();

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

attachGcToTicks(tickSamples, automaticGcEvents);

const tickDurations = tickSamples.map(sample => sample.duration);
const automaticGcDurations = automaticGcEvents.map(event => event.duration);

const peakHeap = Math.max(
    ...memorySamples.map(sample => sample.heapUsed),
    beforeFinalGc.heapUsed,
);
const peakRss = Math.max(
    ...memorySamples.map(sample => sample.rss),
    beforeFinalGc.rss,
);

console.log("=== workload ===");
console.log(`cities: ${cityCount}`);
console.log(`nodes: ${navigation.nodes.size.toLocaleString()}`);
console.log(`roads: ${navigation.roads.size.toLocaleString()}`);
console.log(
    `road index cells: ${navigation.roadIndex.cells.size.toLocaleString()}`,
);
console.log(
    `road index multi-occupancy cells: ${navigation.roadIndex.multiOccupancyCellCount().toLocaleString()}`,
);
console.log(
    `road index memberships: ${navigation.roadIndex.membershipCount().toLocaleString()}`,
);
console.log(
    `entities at run start: ${(cityCount * entitiesPerCity).toLocaleString()}`,
);
console.log(
    `active movers at run start: ${(cityCount * moversPerCity).toLocaleString()}`,
);
console.log(`active movers after run: ${activeMoversAfterRun.toLocaleString()}`);
console.log(`active journeys after run: ${activeJourneys.toLocaleString()}`);
console.log(`graph build: ${graphBuildElapsed.toFixed(2)} ms`);
console.log(
    `unique cold route queries (${queries.length}): ${coldRoutingElapsed.toFixed(2)} ms`,
);
console.log(
    `same warm route queries (${queries.length}): ${warmRoutingElapsed.toFixed(2)} ms`,
);
console.log(
    `cached routes before clear: ${cachedRoutesBeforeClear.toLocaleString()}`,
);
console.log(
    `cached route legs before clear: ${cachedLegsBeforeClear.toLocaleString()}`,
);

console.log("\n=== tick latency ===");
printDurationSummary("tick", tickDurations);
printWorstTicks(tickSamples, 10);

console.log("\n=== memory phases ===");
printMemorySample(startup);
printMemorySample(afterGraph);
printMemorySample(afterRoutes);
printMemorySample(afterPopulation);
printMemorySample(beforeFinalGc);
printMemorySample(afterFinalGc);
printMemorySample(afterCacheClear);
printMemorySample(afterEntityClear);
console.log(`sampled heap peak: ${(peakHeap / 1024 / 1024).toFixed(2)} MiB`);
console.log(`sampled RSS peak: ${(peakRss / 1024 / 1024).toFixed(2)} MiB`);
printMemoryDelta("graph retained", startup, afterGraph);
printMemoryDelta("route-cache retained", afterGraph, afterRoutes);
printMemoryDelta("population retained", afterRoutes, afterPopulation);
printMemoryDelta(
    "uncollected run garbage",
    afterFinalGc,
    beforeFinalGc,
);
printMemoryDelta(
    "post-run retained drift vs pre-run",
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

console.log("\n=== spatial query ===");
console.log(
    `10,000 buffered nearby queries: ${queryElapsed.toFixed(2)} ms`,
);
console.log(`query checksum: ${nearbyCount}`);
