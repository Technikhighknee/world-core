import { performance } from "node:perf_hooks";

import {
    printDurationSummary,
    sampleMemory,
    mib,
} from "./support/metrics.js";
import { Navigation } from "../src/world/navigation.js";
import { startJourney } from "../src/world/movement.js";
import { stepSimulation } from "../src/world/simulation.js";
import { World } from "../src/world/world.js";

const counts = String(
    process.env.STEERING_COUNTS ??
    "100,500,1000,5000",
)
    .split(",")
    .map(value => Number(value.trim()))
    .filter(value => Number.isInteger(value) && value > 0);

const warmupTicks = Number(
    process.env.STEERING_WARMUP_TICKS ?? 20,
);
const measuredTicks = Number(
    process.env.STEERING_TICKS ?? 80,
);
const deltaSeconds = Number(
    process.env.STEERING_DELTA_SECONDS ?? 0.1,
);
const roadWidth = Number(
    process.env.STEERING_ROAD_WIDTH ?? 6,
);

if (counts.length === 0) {
    throw new Error("STEERING_COUNTS must contain at least one positive integer");
}

if (typeof global.gc !== "function") {
    throw new Error("steering benchmark requires --expose-gc");
}

async function collectGarbage() {
    global.gc();
    await new Promise(resolve => setImmediate(resolve));
    global.gc();
    await new Promise(resolve => setImmediate(resolve));
}

function buildScenario(count, steeringEnabled) {
    const roadLength = Math.max(
        1000,
        count * 2 + 400,
    );

    const navigation = new Navigation({
        spatialCellSize: 20,
    });

    navigation.addNode({
        id: "west",
        x: 0,
        y: 0,
    });
    navigation.addNode({
        id: "east",
        x: roadLength,
        y: 0,
    });
    navigation.addRoad({
        id: "main-road",
        from: "west",
        to: "east",
        width: roadWidth,
    });

    const world = new World({
        spatialCellSize: 2,
        localSteering: steeringEnabled
            ? {
                neighborRadius: 3,
                separationGap: 0.1,
                separationStrength: 0.8,
                maxLateralSpeed: 0.9,
                centeringRate: 0.35,
                counterflowStrength: 0.9,
                congestionThreshold: 1,
                congestionStrength: 0.65,
                forwardPressureWeight: 0.35,
                minSpeedMultiplier: 0.2,
                trafficSide: "right",
            }
            : null,
    });

    const margin = 100;
    const span = roadLength - margin * 2;

    for (let i = 0; i < count; i++) {
        const eastbound = i % 2 === 0;
        const x =
            margin +
            ((i + 0.5) / count) * span;

        const id =
            `${eastbound ? "e" : "w"}-${String(i).padStart(6, "0")}`;

        world.addEntity({
            id,
            kind: "person",
            position: {
                x,
                y: 0,
            },
            body: {
                radius:
                    0.28 +
                    (i % 4) * 0.03,
            },
            mobility: {
                profileId: "steering-bench-person",
                speed:
                    1.2 +
                    (i % 5) * 0.04,
            },
        });

        if (
            !startJourney(
                world,
                navigation,
                id,
                eastbound ? "east" : "west",
            )
        ) {
            throw new Error(
                `Failed to start benchmark mover ${id}`,
            );
        }
    }

    return {
        world,
        navigation,
    };
}

function validateScenario(world, navigation) {
    let maxAbsY = 0;
    let nonFinite = 0;
    let corridorViolations = 0;

    for (const entity of world.entities.values()) {
        if (
            !Number.isFinite(entity.position.x) ||
            !Number.isFinite(entity.position.y)
        ) {
            nonFinite++;
            continue;
        }

        maxAbsY = Math.max(
            maxAbsY,
            Math.abs(entity.position.y),
        );

        const usableHalfWidth =
            roadWidth / 2 -
            (entity.body?.radius ?? 0) -
            (world.localSteering?.roadEdgeMargin ?? 0);

        if (
            Math.abs(entity.position.y) >
            usableHalfWidth + 1e-6
        ) {
            corridorViolations++;
        }
    }

    world.assertInternalConsistency();
    navigation.assertInternalConsistency();

    return {
        maxAbsY,
        nonFinite,
        corridorViolations,
    };
}

async function runScenario(count, steeringEnabled) {
    await collectGarbage();

    const memoryBefore =
        sampleMemory("before");

    const {
        world,
        navigation,
    } = buildScenario(
        count,
        steeringEnabled,
    );

    for (let i = 0; i < warmupTicks; i++) {
        stepSimulation(
            world,
            navigation,
            deltaSeconds,
        );
    }

    const durations = [];

    for (let tick = 0; tick < measuredTicks; tick++) {
        const started = performance.now();

        stepSimulation(
            world,
            navigation,
            deltaSeconds,
        );

        durations.push(
            performance.now() - started,
        );
    }

    const validation =
        validateScenario(
            world,
            navigation,
        );

    const activeMovers =
        world.movingEntities.size;

    await collectGarbage();

    const memoryAfter =
        sampleMemory("after");

    return {
        durations,
        activeMovers,
        validation,
        heapDelta:
            memoryAfter.heapUsed -
            memoryBefore.heapUsed,
        rssDelta:
            memoryAfter.rss -
            memoryBefore.rss,
    };
}

for (const count of counts) {
    console.log(
        `\n=== steering crowd: ${count.toLocaleString()} movers ===`,
    );

    const baseline =
        await runScenario(
            count,
            false,
        );

    const steering =
        await runScenario(
            count,
            true,
        );

    console.log("\n-- centerline baseline --");
    printDurationSummary(
        "tick",
        baseline.durations,
    );

    console.log("\n-- local steering --");
    printDurationSummary(
        "tick",
        steering.durations,
    );

    const baselineTotal =
        baseline.durations.reduce(
            (sum, value) => sum + value,
            0,
        );
    const steeringTotal =
        steering.durations.reduce(
            (sum, value) => sum + value,
            0,
        );

    console.log(
        `steering / baseline total-time ratio: ${(steeringTotal / Math.max(baselineTotal, 1e-9)).toFixed(2)}x`,
    );
    console.log(
        `active movers: ${steering.activeMovers.toLocaleString()}/${count.toLocaleString()}`,
    );
    console.log(
        `max lateral offset: ${steering.validation.maxAbsY.toFixed(3)}`,
    );
    console.log(
        `non-finite positions: ${steering.validation.nonFinite}`,
    );
    console.log(
        `corridor violations: ${steering.validation.corridorViolations}`,
    );
    console.log(
        `post-GC heap delta: ${mib(steering.heapDelta).toFixed(2)} MiB`,
    );
    console.log(
        `post-GC RSS delta: ${mib(steering.rssDelta).toFixed(2)} MiB`,
    );

    if (
        steering.validation.nonFinite !== 0 ||
        steering.validation.corridorViolations !== 0
    ) {
        throw new Error(
            "Steering benchmark violated spatial invariants",
        );
    }
}
