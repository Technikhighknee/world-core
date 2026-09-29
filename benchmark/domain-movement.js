import { performance } from "node:perf_hooks";

import {
    Navigation,
    NavigationRegistry,
    World,
    startJourney,
    stepSimulation,
} from "../src/index.js";

const moverCount =
    Number(
        process.env.DOMAIN_MOVE_MOVERS ??
        20_000,
    );
const distributedDomainCount =
    Math.max(
        1,
        Math.min(
            moverCount,
            Number(
                process.env.DOMAIN_MOVE_DOMAINS ??
                10_000,
            ),
        ),
    );
const ticks =
    Number(
        process.env.DOMAIN_MOVE_TICKS ??
        20,
    );

function createTopology() {
    const navigation =
        new Navigation();

    navigation.addNode({
        id: "start",
        x: 0,
        y: 0,
    });
    navigation.addNode({
        id: "end",
        x: 10_000,
        y: 0,
    });
    navigation.addRoad({
        id: "corridor",
        from: "start",
        to: "end",
        width: 3,
    });

    return navigation;
}

function buildScenario({
    distributed,
}) {
    const world =
        new World({
            spatialCellSize: 10,
        });
    const registry =
        new NavigationRegistry();
    const topology =
        createTopology();

    registry.registerTopology(
        "corridor",
        topology,
    );

    if (!distributed) {
        world.addDomain({
            id: "single",
        });
        registry.bindDomain(
            "single",
            "corridor",
        );
    } else {
        for (
            let index = 0;
            index <
                distributedDomainCount;
            index++
        ) {
            const domainId =
                `domain-${index}`;

            world.addDomain({
                id: domainId,
            });
            registry.bindDomain(
                domainId,
                "corridor",
            );
        }
    }

    for (
        let index = 0;
        index < moverCount;
        index++
    ) {
        const domainId =
            distributed
                ? `domain-${
                    index %
                    distributedDomainCount
                }`
                : "single";
        const entityId =
            `mover-${index}`;

        world.addEntity({
            id: entityId,
            domainId,
            position: {
                x: 0,
                y: 0,
            },
            mobility: {
                speed: 1,
            },
        });

        if (
            !startJourney(
                world,
                registry,
                entityId,
                "end",
            )
        ) {
            throw new Error(
                `Failed to start journey for ${entityId}`,
            );
        }
    }

    world.assertInternalConsistency();
    registry.assertInternalConsistency();

    return {
        world,
        registry,
    };
}

function runScenario(
    label,
    distributed,
) {
    const buildStarted =
        performance.now();
    const {
        world,
        registry,
    } = buildScenario({
        distributed,
    });
    const buildMs =
        performance.now() -
        buildStarted;

    const tickStarted =
        performance.now();

    for (
        let tick = 0;
        tick < ticks;
        tick++
    ) {
        stepSimulation(
            world,
            registry,
            1,
        );
    }

    const tickMs =
        performance.now() -
        tickStarted;

    world.assertInternalConsistency();

    return {
        label,
        buildMs,
        tickMs,
        perTickMs:
            tickMs / ticks,
        movers:
            world.movingEntities.size,
        domains:
            world.domains.size - 1,
        spatialCells:
            world.getDiagnostics()
                .spatialCellCount,
    };
}

const single =
    runScenario(
        "single-domain",
        false,
    );
const distributed =
    runScenario(
        "distributed",
        true,
    );

console.log(
    "=== domain movement workload ===",
);
console.log(
    `movers: ${moverCount.toLocaleString()}`,
);
console.log(
    `ticks: ${ticks.toLocaleString()}`,
);
console.log(
    `distributed domains: ${distributedDomainCount.toLocaleString()}`,
);

for (
    const result of
    [single, distributed]
) {
    console.log(
        `\n${result.label}`,
    );
    console.log(
        `build: ${result.buildMs.toFixed(2)} ms`,
    );
    console.log(
        `movement total: ${result.tickMs.toFixed(2)} ms`,
    );
    console.log(
        `movement/tick: ${result.perTickMs.toFixed(3)} ms`,
    );
    console.log(
        `domains: ${result.domains.toLocaleString()}`,
    );
    console.log(
        `spatial cells: ${result.spatialCells.toLocaleString()}`,
    );
}

const ratio =
    single.perTickMs > 0
        ? distributed.perTickMs /
            single.perTickMs
        : 0;

console.log(
    `\ndistributed/single movement ratio: ${ratio.toFixed(3)}x`,
);

if (
    distributed.movers !==
        moverCount ||
    single.movers !== moverCount
) {
    throw new Error(
        "Domain movement benchmark lost active movers",
    );
}
