import {
    performance,
    PerformanceObserver,
} from "node:perf_hooks";
import v8 from "node:v8";

export function percentile(values, p) {
    if (values.length === 0) return 0;

    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(
        sorted.length - 1,
        Math.max(0, Math.ceil(sorted.length * p) - 1),
    );

    return sorted[index];
}

export function mib(bytes) {
    return bytes / 1024 / 1024;
}

export function sampleMemory(label, tick = null) {
    const usage = process.memoryUsage();
    const heap = v8.getHeapStatistics();

    return {
        label,
        tick,
        time: performance.now(),
        heapUsed: usage.heapUsed,
        heapTotal: usage.heapTotal,
        rss: usage.rss,
        external: usage.external,
        arrayBuffers: usage.arrayBuffers,
        totalHeapSize: heap.total_heap_size,
        usedHeapSize: heap.used_heap_size,
        heapSizeLimit: heap.heap_size_limit,
        mallocedMemory: heap.malloced_memory,
        externalMemory: heap.external_memory,
    };
}

export class GcMonitor {
    constructor() {
        this.events = [];

        this.observer = new PerformanceObserver(list => {
            for (const entry of list.getEntries()) {
                this.events.push({
                    startTime: entry.startTime,
                    duration: entry.duration,
                    kind: entry.detail?.kind ?? entry.kind ?? null,
                });
            }
        });

        this.observer.observe({ entryTypes: ["gc"] });
    }

    async flush() {
        await new Promise(resolve => setImmediate(resolve));
    }

    stop() {
        this.observer.disconnect();
    }

    eventsBetween(startTime, endTime) {
        return this.events.filter(
            event =>
                event.startTime >= startTime &&
                event.startTime <= endTime,
        );
    }
}

export async function forceGc(label, samples = [], passes = 2) {
    if (typeof global.gc !== "function") {
        throw new Error(
            "Benchmark requires --expose-gc so retained memory can be distinguished from collectible garbage",
        );
    }

    for (let pass = 0; pass < passes; pass++) {
        const before = process.memoryUsage().heapUsed;
        const started = performance.now();

        global.gc();

        const duration = performance.now() - started;
        await new Promise(resolve => setImmediate(resolve));

        const after = process.memoryUsage().heapUsed;

        samples.push({
            label,
            pass: pass + 1,
            duration,
            heapBefore: before,
            heapAfter: after,
            heapFreed: Math.max(0, before - after),
        });
    }

    return sampleMemory(label);
}

export function summarizeDurations(values) {
    return {
        count: values.length,
        p50: percentile(values, 0.50),
        p95: percentile(values, 0.95),
        p99: percentile(values, 0.99),
        max: values.length > 0 ? Math.max(...values) : 0,
        total: values.reduce((sum, value) => sum + value, 0),
    };
}

export function printDurationSummary(label, values) {
    const summary = summarizeDurations(values);

    console.log(`${label} count: ${summary.count.toLocaleString()}`);
    console.log(`${label} p50: ${summary.p50.toFixed(3)} ms`);
    console.log(`${label} p95: ${summary.p95.toFixed(3)} ms`);
    console.log(`${label} p99: ${summary.p99.toFixed(3)} ms`);
    console.log(`${label} max: ${summary.max.toFixed(3)} ms`);
    console.log(`${label} total: ${summary.total.toFixed(2)} ms`);
}

export function printMemorySample(sample) {
    console.log(
        `${sample.label}: heap=${mib(sample.heapUsed).toFixed(2)} MiB, ` +
        `rss=${mib(sample.rss).toFixed(2)} MiB, ` +
        `external=${mib(sample.external).toFixed(2)} MiB, ` +
        `arrayBuffers=${mib(sample.arrayBuffers).toFixed(2)} MiB`,
    );
}

export function printMemoryDelta(label, before, after) {
    console.log(
        `${label}: heap ${mib(after.heapUsed - before.heapUsed).toFixed(2)} MiB, ` +
        `rss ${mib(after.rss - before.rss).toFixed(2)} MiB`,
    );
}

export function printForcedGc(samples) {
    const durations = samples.map(sample => sample.duration);
    const freed = samples.reduce(
        (sum, sample) => sum + sample.heapFreed,
        0,
    );

    printDurationSummary("forced GC", durations);
    console.log(`forced GC reported freed heap: ${mib(freed).toFixed(2)} MiB`);
}

export function attachGcToTicks(ticks, gcEvents) {
    for (const tick of ticks) {
        let gcDuration = 0;
        let gcCount = 0;

        for (const event of gcEvents) {
            if (
                event.startTime >= tick.startTime &&
                event.startTime <= tick.endTime
            ) {
                gcDuration += event.duration;
                gcCount++;
            }
        }

        tick.gcDuration = gcDuration;
        tick.gcCount = gcCount;
    }
}

export function printWorstTicks(ticks, count = 10) {
    const worst = [...ticks]
        .sort((a, b) => b.duration - a.duration)
        .slice(0, count);

    console.log(`worst ${worst.length} ticks:`);

    for (const tick of worst) {
        console.log(
            `  tick=${tick.tick} duration=${tick.duration.toFixed(3)} ms ` +
            `gc=${tick.gcDuration.toFixed(3)} ms/${tick.gcCount} ` +
            `movers=${tick.movers.toLocaleString()}`,
        );
    }
}
