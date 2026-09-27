process.env.CHURN_TICKS ??= "5000";
process.env.CHURN_MOVERS ??= "20000";
process.env.CHURN_REROUTES_PER_TICK ??= "150";
process.env.CHURN_STOP_STARTS_PER_TICK ??= "150";
process.env.CHURN_MOVER_REPLACEMENTS_PER_TICK ??= "50";
process.env.CHURN_IDLE_REPLACEMENTS_PER_TICK ??= "50";
process.env.CHURN_RETENTION_CHECK_EVERY ??= "500";
process.env.CHURN_MEMORY_SAMPLE_EVERY ??= "25";

await import("./churn.js");
