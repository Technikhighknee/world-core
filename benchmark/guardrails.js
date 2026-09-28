import {
    spawnSync,
} from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
    path.dirname(
        fileURLToPath(import.meta.url),
    ),
    "..",
);

const fast =
    process.env.GUARDRAIL_FAST ===
    "1";

function numberEnv(
    name,
    fallback,
) {
    const raw =
        process.env[name];

    if (raw == null) {
        return fallback;
    }

    const value = Number(raw);

    if (!Number.isFinite(value)) {
        throw new Error(
            `${name} must be a finite number`,
        );
    }

    return value;
}

const limits = {
    churnP99Ms:
        numberEnv(
            "GUARDRAIL_CHURN_P99_MS",
            150,
        ),
    churnHeapMiB:
        numberEnv(
            "GUARDRAIL_CHURN_HEAP_MIB",
            512,
        ),
    churnRssMiB:
        numberEnv(
            "GUARDRAIL_CHURN_RSS_MIB",
            768,
        ),
    snapshotJsonMiB:
        numberEnv(
            "GUARDRAIL_SNAPSHOT_JSON_MIB",
            64,
        ),
    snapshotValidateMs:
        numberEnv(
            "GUARDRAIL_SNAPSHOT_VALIDATE_MS",
            1000,
        ),
    snapshotDeserializeMs:
        numberEnv(
            "GUARDRAIL_SNAPSHOT_DESERIALIZE_MS",
            3000,
        ),
    steeringP99Ms:
        numberEnv(
            "GUARDRAIL_STEERING_P99_MS",
            75,
        ),
    steeringRatio:
        numberEnv(
            "GUARDRAIL_STEERING_RATIO",
            50,
        ),
};

function runNode(
    label,
    script,
    env = {},
) {
    console.log(
        `\n=== guardrail workload: ${label} ===`,
    );

    const result =
        spawnSync(
            process.execPath,
            [
                "--expose-gc",
                path.join(
                    root,
                    script,
                ),
            ],
            {
                cwd: root,
                env: {
                    ...process.env,
                    ...env,
                },
                encoding: "utf8",
                maxBuffer:
                    64 *
                    1024 *
                    1024,
            },
        );

    if (result.stdout) {
        process.stdout.write(
            result.stdout,
        );
    }

    if (result.stderr) {
        process.stderr.write(
            result.stderr,
        );
    }

    if (result.status !== 0) {
        throw new Error(
            `${label} benchmark failed with exit code ${result.status}`,
        );
    }

    return (
        result.stdout +
        result.stderr
    );
}

function metric(
    output,
    regex,
    label,
    {
        last = false,
    } = {},
) {
    const matches =
        [...output.matchAll(regex)];

    if (matches.length === 0) {
        throw new Error(
            `Could not parse ${label}`,
        );
    }

    const match =
        last
            ? matches.at(-1)
            : matches[0];
    const value =
        Number(match[1]);

    if (!Number.isFinite(value)) {
        throw new Error(
            `Parsed non-finite ${label}`,
        );
    }

    return value;
}

function assertAtMost(
    label,
    actual,
    limit,
) {
    const status =
        actual <= limit
            ? "PASS"
            : "FAIL";

    console.log(
        `${status}: ${label}: ${actual.toFixed(3)} <= ${limit.toFixed(3)}`,
    );

    if (actual > limit) {
        throw new Error(
            `Performance guardrail exceeded: ${label}=${actual}, limit=${limit}`,
        );
    }
}

const churnOutput =
    runNode(
        "churn",
        "benchmark/churn.js",
        fast
            ? {
                CHURN_CITIES: "2",
                CHURN_GRID_SIZE: "6",
                CHURN_ENTITIES: "400",
                CHURN_MOVERS: "200",
                CHURN_TICKS: "30",
                CHURN_REROUTES_PER_TICK:
                    "4",
                CHURN_STOP_STARTS_PER_TICK:
                    "4",
                CHURN_MOVER_REPLACEMENTS_PER_TICK:
                    "2",
                CHURN_IDLE_REPLACEMENTS_PER_TICK:
                    "2",
                CHURN_RETENTION_CHECK_EVERY:
                    "15",
                CHURN_MEMORY_SAMPLE_EVERY:
                    "5",
            }
            : {},
    );

const churnP99 =
    metric(
        churnOutput,
        /simulation tick p99:\s+([\d.]+) ms/g,
        "churn p99",
    );
const churnHeap =
    metric(
        churnOutput,
        /sampled heap peak:\s+([\d.]+) MiB/g,
        "churn heap peak",
    );
const churnRss =
    metric(
        churnOutput,
        /sampled RSS peak:\s+([\d.]+) MiB/g,
        "churn RSS peak",
    );

const snapshotOutput =
    runNode(
        "snapshot",
        "benchmark/snapshot.js",
        fast
            ? {
                SNAPSHOT_CITIES: "2",
                SNAPSHOT_GRID_SIZE: "6",
                SNAPSHOT_ENTITIES: "400",
                SNAPSHOT_MOVERS: "160",
            }
            : {},
    );

const snapshotJson =
    metric(
        snapshotOutput,
        /JSON MiB:\s+([\d.]+)/g,
        "snapshot JSON MiB",
    );
const snapshotValidate =
    metric(
        snapshotOutput,
        /validate:\s+([\d.]+) ms/g,
        "snapshot validate",
    );
const snapshotDeserialize =
    metric(
        snapshotOutput,
        /deserialize:\s+([\d.]+) ms/g,
        "snapshot deserialize",
    );

const steeringOutput =
    runNode(
        "steering",
        "benchmark/steering.js",
        fast
            ? {
                STEERING_COUNTS: "50",
                STEERING_WARMUP_TICKS:
                    "3",
                STEERING_TICKS: "8",
            }
            : {},
    );

const steeringP99 =
    metric(
        steeringOutput,
        /-- local steering --[\s\S]*?tick p99:\s+([\d.]+) ms/g,
        "steering p99",
        {
            last: true,
        },
    );
const steeringRatio =
    metric(
        steeringOutput,
        /steering \/ baseline total-time ratio:\s+([\d.]+)x/g,
        "steering ratio",
        {
            last: true,
        },
    );

console.log(
    "\n=== performance guardrails ===",
);

assertAtMost(
    "50k/20k churn simulation p99 (ms)",
    churnP99,
    limits.churnP99Ms,
);
assertAtMost(
    "churn sampled heap peak (MiB)",
    churnHeap,
    limits.churnHeapMiB,
);
assertAtMost(
    "churn sampled RSS peak (MiB)",
    churnRss,
    limits.churnRssMiB,
);
assertAtMost(
    "snapshot JSON size (MiB)",
    snapshotJson,
    limits.snapshotJsonMiB,
);
assertAtMost(
    "snapshot validation (ms)",
    snapshotValidate,
    limits.snapshotValidateMs,
);
assertAtMost(
    "snapshot deserialize (ms)",
    snapshotDeserialize,
    limits.snapshotDeserializeMs,
);
assertAtMost(
    "5k steering p99 (ms)",
    steeringP99,
    limits.steeringP99Ms,
);
assertAtMost(
    "steering/baseline ratio",
    steeringRatio,
    limits.steeringRatio,
);

console.log(
    "\nAll performance guardrails passed.",
);
