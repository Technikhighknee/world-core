# world-core

A rendering-independent 2D world, navigation and movement simulation core.

The world stores actual entity coordinates. Navigation is a separate graph used to plan routes; movement advances entities through world space and keeps the dynamic spatial index synchronized.

## Scalability model

- `World.entities` is the master entity registry.
- Active movement is tracked separately from the full population.
- Movement advances numeric `x/y` state without temporary Vec2/object allocations in the hot loop and commits each entity position at most once per processed movement update.
- Movement LOD supports full-detail nearby movers and coarse scheduled updates for distant movers.
- Dynamic entity lookups use a spatial hash. World entities are indexed by center cell only; body radius is handled by query expansion plus exact distance checks, so large bodies remain query-correct without duplicating dynamic memberships across neighboring cells. Moving inside the same center cell does not rewrite hash buckets.
- Normal cell coordinates use packed numeric keys instead of transient string keys, and singleton cells store the entity ID directly instead of allocating a Set.
- Reusable spatial query buffers are available through `createSpatialQueryBuffer()` and the allocation-conscious `queryRadiusInto()`, `queryAabbInto()`, `querySegmentInto()`, and `queryCapsuleInto()` APIs.
- Spatial primitives include radius, AABB, segment, capsule, and nearest-body queries with exact body-radius filtering.
- `maxEntityRadius` shrinks when large entities are removed or resized.
- Frozen mobility profiles are shared between entities instead of duplicated by `structuredClone()`.
- Navigation nodes and roads use static spatial indexes for local `nodeAt`, `nearestNode` and `roadAt` queries.
- Long road segments are indexed along traversed centerline cells rather than filling their entire bounding box. Road width is applied at query time, avoiding broad padded road-index footprints.
- Routing uses A* with a binary min-heap rather than an O(V^2) full scan.
- Cached routes contain only road IDs and direction flags, not duplicated road geometry.
- The route cache is bounded by both route count and total retained leg count.
- Local topology changes invalidate only the affected connected component.
- Journeys can start and re-route while an entity is already in the middle of a road.
- `nearestNode()` consistently returns a node; `nearestNodeWithDistance()` returns node plus distance.

## Benchmarking

```bash
npm run bench
npm run bench:churn
npm run bench:soak
npm run bench:retention
```

All benchmarks run with `--expose-gc`. This is intentional: the reports distinguish memory that is merely waiting for garbage collection from memory that remains reachable after forced full collections.

### Standard scalability benchmark

The standard benchmark builds a multi-city navigation graph, warms a bounded route cache, creates a large population, then runs movement and spatial-query load.

It reports:

- p50, p95, p99 and max simulation tick latency
- the ten slowest ticks and GC time overlapping each tick
- observed automatic GC count and pause distributions
- separately timed forced GC passes
- heap/RSS before and after forced GC
- retained memory by graph, route cache and population
- collectible end-of-run garbage
- post-run retained drift relative to the post-GC pre-run baseline
- V8 old-space, new-space and large-object-space usage
- route-cache route/leg counts
- road-index membership counts

### Constant-load churn benchmark

`npm run bench:churn` keeps 20,000 movers active by default while holding total population constant. During every tick it also performs configurable amounts of:

- mid-road re-routing
- stop/start journey cycles
- moving-entity deletion/recreation
- idle-entity deletion/recreation
- completed-journey restart

The benchmark asserts that both total entity count and target mover count remain constant after every maintenance phase. It measures simulation latency separately from churn-maintenance latency.

Post-GC retention checkpoints are taken throughout the run. A steadily increasing post-GC line is evidence of retained state; a large pre-GC heap that collapses at the checkpoint is collectible garbage rather than a leak.

### Retention benchmark

`npm run bench:retention` runs the same 5,000-tick constant-load lifecycle workload without accumulating per-tick latency samples or automatic-GC event history. This keeps the benchmark harness itself from creating a growing retained-memory signal, so post-GC checkpoints are suitable for leak/retention analysis.

### Soak benchmark

`npm run bench:soak` runs the churn workload for 5,000 ticks by default with 20,000 continuously maintained movers and heavier lifecycle churn. Environment variables prefixed with `BENCH_` and `CHURN_` can override workload sizes.
