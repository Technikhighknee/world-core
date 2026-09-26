process.env.BENCH_TICKS ??= "2000";
process.env.BENCH_MOVERS_PER_CITY ??= "1000";
process.env.BENCH_MEMORY_SAMPLE_EVERY ??= "25";

await import("./scalability.js");
