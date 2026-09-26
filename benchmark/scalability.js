import {
    performance,
    PerformanceObserver,
} from "node:perf_hooks";

import { mobilityProfile } from "../src/world/mobility-profiles.js";
import { Navigation } from "../src/world/navigation.js";
import { startJourney } from "../src/world/movement.js";
import { stepSimulation } from "../src/world/simulation.js";
import { World } from "../src/world/world.js";

const cityCount = Number(process.env.BENCH_CITIES ?? 20);
const gridSize = Number(process.env.BENCH_GRID_SIZE ?? 20);
const nodeSpacing = 50;
const entitiesPerCity = Number(process.env.BENCH_ENTITIES_PER_CITY ?? 2500);
const moversPerCity = Number(process.env.BENCH_MOVERS_PER_CITY ?? 750);
const ticks = Number(process.env.BENCH_TICKS ?? 300);
const citySpacing = 10000;
const routeQueries = Number(process.env.BENCH_ROUTE_QUERIES ?? 2000);
const memorySampleEvery = Number(process.env.BENCH_MEMORY_SAMPLE_EVERY ?? 10);

const pedestrian = mobilityProfile("pedestrian");
const world = new World({ spatialCellSize: 10 });
const navigation = new Navigation({
    spatialCellSize: 50,
    routeCacheSize: 20000,
    routeCacheMaxLegs: 256,
});

const gcDurations = [];
const gcObserver = new PerformanceObserver(list => {
    for (const entry of list.getEntries()) {
        gcDurations.push(entry.duration);
    }
});

gcObserver.observe({ entryTypes: ["gc"] });

function percentile(values, p) {
    if (values.length === 0) return 0;

    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(
        sorted.length - 1,
        Math.max(0, Math.ceil(sorted.length * p) - 1),
    );

    return sorted[index];
}

function mb(bytes) {
    return bytes / 1024 / 1024;
}

function nodeId(city, x, y) {
    return `city-${city}-node-${x}-${y}`;
}

function addCityGraph(city) {
    const originX = city * citySpacing;

    for (let y = 0; y < gridSize; y++) {
        for (let x = 0; x < gridSize; x++) {
            navigation.addNode({
                id: nodeId(city, x, y),
                x: originX + x * nodeSpacing,
                y: y * nodeSpacing,
            });
        }
    }

    for (let y = 0; y < gridSize; y++) {
        for (let x = 0; x < gridSize; x++) {
            if (x + 1 < gridSize) {
                const from = nodeId(city, x, y);
                const to = nodeId(city, x + 1, y);
                const baseX = originX + x * nodeSpacing;
                const baseY = y * nodeSpacing;

                navigation.addRoad({
                    id: `city-${city}-h-${x}-${y}`,
                    from,
                    to,
                    width: 5,
                    surface: (x + y) % 7 === 0 ? "mud" : "street",
                    shape: [
                        { x: baseX + 12.5, y: baseY + 1.5 },
                        { x: baseX + 25, y: baseY - 1.5 },
                        { x: baseX + 37.5, y: baseY + 1 },
                    ],
                });
            }

            if (y + 1 < gridSize) {
                const from = nodeId(city, x, y);
                const to = nodeId(city, x, y + 1);
                const baseX = originX + x * nodeSpacing;
                const baseY = y * nodeSpacing;

                navigation.addRoad({
                    id: `city-${city}-v-${x}-${y}`,
                    from,
                    to,
                    width: 4,
                    surface: (x * 3 + y) % 11 === 0 ? "mud" : "street",
                    shape: [
                        { x: baseX + 1.5, y: baseY + 12.5 },
                        { x: baseX - 1, y: baseY + 25 },
                        { x: baseX + 1, y: baseY + 37.5 },
                    ],
                });
            }
        }
    }
}

function createRouteQueries(count) {
    let state = 0x12345678;
    const queries = [];
    const seen = new Set();

    function nextInt(max) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state % max;
    }

    while (queries.length < count) {
        const city = nextInt(cityCount);
        const sourceX = nextInt(gridSize);
        const sourceY = nextInt(gridSize);
        const destinationX = nextInt(gridSize);
        const destinationY = nextInt(gridSize);

        if (sourceX === destinationX && sourceY === destinationY) continue;

        const key =
            `${city}:${sourceX}:${sourceY}:${destinationX}:${destinationY}`;

        if (seen.has(key)) continue;
        seen.add(key);

        queries.push({
            from: nodeId(city, sourceX, sourceY),
            to: nodeId(city, destinationX, destinationY),
        });
    }

    return queries;
}

function sampleMemory(tick) {
    const usage = process.memoryUsage();

    return {
        tick,
        heapUsed: usage.heapUsed,
        heapTotal: usage.heapTotal,
        rss: usage.rss,
        external: usage.external,
    };
}

const buildStarted = performance.now();

for (let city = 0; city < cityCount; city++) {
    addCityGraph(city);
}

const graphBuildElapsed = performance.now() - buildStarted;
const queries = createRouteQueries(routeQueries);

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

for (let city = 0; city < cityCount; city++) {
    const originX = city * citySpacing;

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

global.gc?.();

const memorySamples = [sampleMemory(0)];
const tickTimes = [];

for (let tick = 1; tick <= ticks; tick++) {
    const started = performance.now();
    stepSimulation(world, navigation, 1);
    tickTimes.push(performance.now() - started);

    if (tick % memorySampleEvery === 0 || tick === ticks) {
        memorySamples.push(sampleMemory(tick));
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

await new Promise(resolve => setImmediate(resolve));
gcObserver.disconnect();

const initialMemory = memorySamples[0];
const finalMemory = memorySamples[memorySamples.length - 1];
const peakHeap = Math.max(...memorySamples.map(sample => sample.heapUsed));
const peakRss = Math.max(...memorySamples.map(sample => sample.rss));
const cachedLegs = [...navigation.routeCache.values()]
    .reduce((total, entry) => total + entry.route.legs.length, 0);

console.log(`cities: ${cityCount}`);
console.log(`nodes: ${navigation.nodes.size.toLocaleString()}`);
console.log(`roads: ${navigation.roads.size.toLocaleString()}`);
console.log(`road index memberships: ${navigation.roadIndex.membershipCount().toLocaleString()}`);
console.log(`entities: ${world.entities.size.toLocaleString()}`);
console.log(`active movers at start: ${(cityCount * moversPerCity).toLocaleString()}`);
console.log(`active movers after run: ${world.movingEntities.size.toLocaleString()}`);
console.log(`graph build: ${graphBuildElapsed.toFixed(2)} ms`);
console.log(`unique cold route queries (${queries.length}): ${coldRoutingElapsed.toFixed(2)} ms`);
console.log(`same warm route queries (${queries.length}): ${warmRoutingElapsed.toFixed(2)} ms`);
console.log(`cached routes: ${navigation.routeCache.size.toLocaleString()}`);
console.log(`cached route legs: ${cachedLegs.toLocaleString()}`);
console.log(`movement ticks: ${ticks}`);
console.log(`tick p50: ${percentile(tickTimes, 0.50).toFixed(3)} ms`);
console.log(`tick p95: ${percentile(tickTimes, 0.95).toFixed(3)} ms`);
console.log(`tick p99: ${percentile(tickTimes, 0.99).toFixed(3)} ms`);
console.log(`tick max: ${Math.max(...tickTimes).toFixed(3)} ms`);
console.log(`heap start: ${mb(initialMemory.heapUsed).toFixed(2)} MiB`);
console.log(`heap end: ${mb(finalMemory.heapUsed).toFixed(2)} MiB`);
console.log(`heap peak: ${mb(peakHeap).toFixed(2)} MiB`);
console.log(`heap delta: ${mb(finalMemory.heapUsed - initialMemory.heapUsed).toFixed(2)} MiB`);
console.log(`rss start: ${mb(initialMemory.rss).toFixed(2)} MiB`);
console.log(`rss end: ${mb(finalMemory.rss).toFixed(2)} MiB`);
console.log(`rss peak: ${mb(peakRss).toFixed(2)} MiB`);
console.log(`GC events: ${gcDurations.length}`);
console.log(`GC total: ${gcDurations.reduce((sum, value) => sum + value, 0).toFixed(2)} ms`);
console.log(`GC p95: ${percentile(gcDurations, 0.95).toFixed(3)} ms`);
console.log(`GC max: ${(gcDurations.length ? Math.max(...gcDurations) : 0).toFixed(3)} ms`);
console.log(`10,000 buffered nearby queries: ${queryElapsed.toFixed(2)} ms`);
console.log(`query checksum: ${nearbyCount}`);
