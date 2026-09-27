import inspector from "node:inspector";
import { performance } from "node:perf_hooks";

import { mobilityProfile } from "../src/world/mobility-profiles.js";
import { startJourney } from "../src/world/movement.js";
import { stepSimulation } from "../src/world/simulation.js";
import { World } from "../src/world/world.js";
import {
    printDurationSummary,
} from "./support/metrics.js";
import {
    buildCityNavigation,
    cityOriginX,
    nodeId,
} from "./support/scenario.js";

const cityCount = Number(process.env.PROFILE_CITIES ?? 20);
const gridSize = Number(process.env.PROFILE_GRID_SIZE ?? 20);
const nodeSpacing = Number(process.env.PROFILE_NODE_SPACING ?? 50);
const citySpacing = Number(process.env.PROFILE_CITY_SPACING ?? 10000);
const entitiesPerCity = Number(
    process.env.PROFILE_ENTITIES_PER_CITY ?? 2500,
);
const moversPerCity = Number(
    process.env.PROFILE_MOVERS_PER_CITY ?? 1000,
);
const warmupTicks = Number(process.env.PROFILE_WARMUP_TICKS ?? 800);
const ticks = Number(process.env.PROFILE_TICKS ?? 200);
const samplingIntervalMicros = Number(
    process.env.PROFILE_SAMPLING_INTERVAL_US ?? 500,
);

const pedestrian = mobilityProfile("pedestrian");

const { navigation } = buildCityNavigation({
    cityCount,
    gridSize,
    nodeSpacing,
    citySpacing,
    routeCacheSize: 20000,
    routeCacheMaxLegs: 256,
    routeCacheMaxTotalLegs: 100000,
});

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

if (world.movingEntities.size !== cityCount * moversPerCity) {
    throw new Error("Profiler scenario mover count mismatch");
}

function post(session, method, params = {}) {
    return new Promise((resolve, reject) => {
        session.post(method, params, (error, result) => {
            if (error) reject(error);
            else resolve(result);
        });
    });
}

function summarizeProfile(profile) {
    const nodes = new Map(
        profile.nodes.map(node => [node.id, node]),
    );
    const selfMicros = new Map();

    for (let i = 0; i < profile.samples.length; i++) {
        const nodeId = profile.samples[i];
        const delta = profile.timeDeltas[i] ?? 0;

        selfMicros.set(
            nodeId,
            (selfMicros.get(nodeId) ?? 0) + delta,
        );
    }

    const totalMicros = [...selfMicros.values()]
        .reduce((sum, value) => sum + value, 0);

    return [...selfMicros.entries()]
        .map(([nodeId, micros]) => {
            const node = nodes.get(nodeId);
            const frame = node?.callFrame ?? {};

            return {
                functionName: frame.functionName || "(anonymous)",
                url: frame.url || "",
                line: (frame.lineNumber ?? -1) + 1,
                micros,
                percent:
                    totalMicros > 0
                        ? micros / totalMicros * 100
                        : 0,
            };
        })
        .filter(entry =>
            entry.functionName !== "(idle)" &&
            entry.functionName !== "(program)"
        )
        .sort((a, b) => b.micros - a.micros);
}

const warmupDurations = [];

for (let tick = 0; tick < warmupTicks; tick++) {
    const started = performance.now();
    stepSimulation(world, navigation, 1);
    warmupDurations.push(performance.now() - started);
}

const beforeProfile = world.assertInternalConsistency();

const session = new inspector.Session();
session.connect();

await post(session, "Profiler.enable");
await post(session, "Profiler.setSamplingInterval", {
    interval: samplingIntervalMicros,
});
await post(session, "Profiler.start");

const tickDurations = [];

for (let tick = 0; tick < ticks; tick++) {
    const started = performance.now();
    stepSimulation(world, navigation, 1);
    tickDurations.push(performance.now() - started);
}

const { profile } = await post(session, "Profiler.stop");
session.disconnect();

const hotFunctions = summarizeProfile(profile);

console.log("=== movement CPU profile ===");
console.log(`entities: ${world.entities.size.toLocaleString()}`);
console.log(
    `active movers: ${world.movingEntities.size.toLocaleString()}`,
);
console.log(`warmup ticks: ${warmupTicks.toLocaleString()}`);
console.log(`profiled ticks: ${ticks.toLocaleString()}`);
console.log(
    `sampling interval: ${samplingIntervalMicros.toLocaleString()} us`,
);
console.log(
    `spatial cells before profile: ${beforeProfile.spatialCellCount.toLocaleString()}`,
);
console.log(
    `spatial memberships before profile: ${beforeProfile.spatialMemberships.toLocaleString()}`,
);
console.log(
    `multi-occupancy cells before profile: ${beforeProfile.spatialMultiOccupancyCells.toLocaleString()}`,
);
printDurationSummary("warmup tick", warmupDurations);
printDurationSummary("profiled tick", tickDurations);

console.log("\n=== top sampled self-time ===");

for (const entry of hotFunctions.slice(0, 30)) {
    const location = entry.url
        ? `${entry.url.split("/").pop()}:${entry.line}`
        : "<native>";

    console.log(
        `${entry.percent.toFixed(2).padStart(6)}% ` +
        `${(entry.micros / 1000).toFixed(2).padStart(9)} ms  ` +
        `${entry.functionName}  ${location}`,
    );
}
