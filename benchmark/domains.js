import { performance } from "node:perf_hooks";

import {
    Navigation,
    NavigationRegistry,
    World,
    stepSimulation,
} from "../src/index.js";

const domainCount =
    Number(
        process.env.DOMAIN_BENCH_DOMAINS ??
        100_000,
    );
const transferCount =
    Number(
        process.env.DOMAIN_BENCH_TRANSFERS ??
        100_000,
    );
const overrideCount =
    Math.min(
        domainCount,
        Number(
            process.env.DOMAIN_BENCH_OVERRIDES ??
            1_000,
        ),
    );
const emptyTickCount =
    Number(
        process.env.DOMAIN_BENCH_EMPTY_TICKS ??
        10_000,
    );

function forceGc() {
    if (global.gc) global.gc();
}

function mib(bytes) {
    return (
        bytes /
        1024 /
        1024
    ).toFixed(2);
}

forceGc();
const before =
    process.memoryUsage();

const world =
    new World();

const createStarted =
    performance.now();

for (
    let index = 0;
    index < domainCount;
    index++
) {
    world.addDomain({
        id: `interior-${index}`,
    });
}

const createMs =
    performance.now() -
    createStarted;

forceGc();
const afterDomains =
    process.memoryUsage();

const topology =
    new Navigation();

topology.addNode({
    id: "a",
    x: 0,
    y: 0,
});
topology.addNode({
    id: "b",
    x: 10,
    y: 0,
});
topology.addRoad({
    id: "hall",
    from: "a",
    to: "b",
});

const registry =
    new NavigationRegistry();

registry.registerTopology(
    "interior",
    topology,
);

const bindingStarted =
    performance.now();

for (
    let index = 0;
    index < domainCount;
    index++
) {
    registry.bindDomain(
        `interior-${index}`,
        "interior",
    );
}

const bindingMs =
    performance.now() -
    bindingStarted;

forceGc();
const afterBindings =
    process.memoryUsage();

const overrideStarted =
    performance.now();

for (
    let index = 0;
    index < overrideCount;
    index++
) {
    registry.setDomainRoadEffect(
        `interior-${index}`,
        "domain-bench",
        "hall",
        {
            costMultiplier: 2,
        },
    );
}

const overrideMs =
    performance.now() -
    overrideStarted;

forceGc();
const afterOverrides =
    process.memoryUsage();

const emptyTickStarted =
    performance.now();

for (
    let index = 0;
    index < emptyTickCount;
    index++
) {
    stepSimulation(
        world,
        registry,
        0.05,
    );
}

const emptyTickMs =
    performance.now() -
    emptyTickStarted;

world.addEntity({
    id: "transfer-probe",
    position: {
        x: 0,
        y: 0,
    },
});

const transferStarted =
    performance.now();

for (
    let index = 0;
    index < transferCount;
    index++
) {
    const target =
        index % domainCount;

    world.transferEntity(
        "transfer-probe",
        {
            domainId:
                `interior-${target}`,
            position: {
                x:
                    index % 11,
                y:
                    index % 7,
            },
        },
    );
}

const transferMs =
    performance.now() -
    transferStarted;

forceGc();
const afterTransfers =
    process.memoryUsage();

const diagnostics =
    world.assertInternalConsistency();
const navigationDiagnostics =
    registry.assertInternalConsistency();

if (
    diagnostics.spatialCellCount !== 1 ||
    diagnostics
        .occupiedSpatialDomainCount !==
        1
) {
    throw new Error(
        "Domain benchmark detected non-sparse spatial allocation",
    );
}

if (
    navigationDiagnostics
        .topologyCount !== 1 ||
    navigationDiagnostics
        .boundDomainCount !==
        domainCount
) {
    throw new Error(
        "Domain benchmark detected navigation topology duplication",
    );
}

if (
    navigationDiagnostics
        .overriddenDomainCount !==
        overrideCount ||
    navigationDiagnostics
        .overrideRoadCount !==
        overrideCount ||
    navigationDiagnostics
        .overrideEffectCount !==
        overrideCount
) {
    throw new Error(
        "Domain benchmark detected non-sparse navigation instance allocation",
    );
}

console.log("=== domain workload ===");
console.log(
    `domains: ${domainCount.toLocaleString()}`,
);
console.log(
    `shared navigation topologies: ${navigationDiagnostics.topologyCount}`,
);
console.log(
    `domains with navigation overrides: ${navigationDiagnostics.overriddenDomainCount.toLocaleString()}`,
);
console.log(
    `spatial cells after creation: ${diagnostics.spatialCellCount}`,
);
console.log(
    `occupied spatial domains: ${diagnostics.occupiedSpatialDomainCount}`,
);

console.log("\n=== timings ===");
console.log(
    `domain creation: ${createMs.toFixed(2)} ms`,
);
console.log(
    `navigation bindings: ${bindingMs.toFixed(2)} ms`,
);
console.log(
    `${overrideCount.toLocaleString()} sparse navigation overrides: ${overrideMs.toFixed(2)} ms`,
);
console.log(
    `${emptyTickCount.toLocaleString()} empty-world ticks across ${domainCount.toLocaleString()} domains: ${emptyTickMs.toFixed(2)} ms`,
);
console.log(
    `${transferCount.toLocaleString()} transfers: ${transferMs.toFixed(2)} ms`,
);

console.log("\n=== retained heap ===");
console.log(
    `baseline: ${mib(before.heapUsed)} MiB`,
);
console.log(
    `after domains: ${mib(afterDomains.heapUsed)} MiB`,
);
console.log(
    `after bindings: ${mib(afterBindings.heapUsed)} MiB`,
);
console.log(
    `after sparse overrides: ${mib(afterOverrides.heapUsed)} MiB`,
);
console.log(
    `after transfers: ${mib(afterTransfers.heapUsed)} MiB`,
);
console.log(
    `domain delta: ${mib(afterDomains.heapUsed - before.heapUsed)} MiB`,
);
console.log(
    `binding delta: ${mib(afterBindings.heapUsed - afterDomains.heapUsed)} MiB`,
);
console.log(
    `override delta: ${mib(afterOverrides.heapUsed - afterBindings.heapUsed)} MiB`,
);
