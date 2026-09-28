# world-core

A rendering-independent 2D world, navigation and movement simulation core.

## Public API

```js
import {
  World,
  Navigation,
  mobilityProfile,
  startJourney,
  rerouteJourney,
  stopJourney,
  stepSimulation,
  serializeWorldCore,
  deserializeWorldCore
} from "world-core";
```

The package root intentionally exposes the simulation-level API only. Spatial hash implementations, the static navigation index, priority queue and geometry helpers remain internal implementation details.

The world stores actual entity coordinates. Navigation is a separate graph used to plan routes; movement advances entities through world space and keeps the dynamic spatial index synchronized.

## Scalability model

- `World.entities` is the master entity registry.
- Active movement is tracked separately from the full population.
- Movement advances numeric `x/y` state without temporary Vec2/object allocations in the hot loop and commits each entity position at most once per processed movement update.
- Movement LOD supports full-detail nearby movers and coarse scheduled updates for distant movers.
- Optional local steering uses nearby spatial occupancy for lateral separation inside the road corridor and derives congestion speed penalties from actual local bodies rather than a precomputed road congestion flag.
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


## Local steering

Local steering is disabled by default so large full-rate movement workloads keep the minimal centerline hot path.

```js
const world = new World({
  localSteering: {
    neighborRadius: 2.5,
    separationGap: 0.1,
    separationStrength: 0.75,
    maxLateralSpeed: 0.8,
    congestionThreshold: 1,
    congestionStrength: 0.65,
    minSpeedMultiplier: 0.2
  }
});
```

When enabled, moving entities query their local neighborhood, derive a lateral separation correction from body radii, clamp that correction to the usable road width, and derive a speed multiplier from local occupancy and forward pressure. Individual mobility definitions can opt out with `localSteering: false`.


## Movement events

Event capture is opt-in so the default high-volume movement path does not allocate event objects.

```js
const world = new World({ captureEvents: true });

// ... simulate ...

const events = world.drainEvents();
```

Movement emits deterministic lifecycle events for journey start, reroute, cancellation, completion and failure, plus road entry/exit transitions. `drainEvents(target)` can reuse a caller-owned array.


## Save / load

`serializeWorldCore(world, navigation)` returns a JSON-safe versioned snapshot. `deserializeWorldCore(snapshot)` restores a fresh `World` and `Navigation` pair.

Snapshots preserve dynamic road state and versions, world time, entities, body state, mobility, active journeys, shared journey routes, movement LOD configuration and interval accumulators. Route caches and pending movement events are intentionally transient and are not restored.


## Steering stress and stability

Local steering keeps a persistent lateral offset per entity and road direction. That offset is rate-limited, recenters gradually when conflicts disappear, uses a consistent traffic side for opposing movers, and uses deterministic pairwise separation for same-direction movers.

A dedicated crowd benchmark compares the centerline baseline against local steering for configurable counterflow populations:

```bash
npm run bench:steering
STEERING_COUNTS=100,500,1000,5000 npm run bench:steering
```

The benchmark reports p50/p95/p99/max tick latency, steering-to-baseline cost ratio, post-GC memory deltas, finite-position checks and road-corridor violations.


## Junctions and obstacles

Navigation nodes can define a `junctionRadius`. Intermediate journey legs may transition to the next road anywhere inside that junction area instead of forcing every mover through the exact mathematical node center.

```js
navigation.addNode({
  id: "market-crossing",
  x: 100,
  y: 50,
  junctionRadius: 3
});
```

The world also owns an indexed obstacle field for spatial steering obstacles. Circle, AABB and capsule-like segment obstacles are supported and may be enabled, disabled, replaced or removed without rebuilding the entity spatial hash.

```js
world.addObstacle({
  id: "market-stall",
  type: "aabb",
  minX: 20,
  minY: 10,
  maxX: 24,
  maxY: 14
});
```

Local steering considers enabled obstacles inside its configured lookahead and avoids them while respecting the usable road corridor.

Temporary routing effects are separate from obstacle geometry. They let a consumer block or penalize a road without deleting or permanently disabling it:

```js
navigation.setRoadEffect(
  "closed-gate",
  "north-gate-road",
  { blocked: true }
);

navigation.setRoadEffect(
  "market-crowd",
  "market-road",
  { costMultiplier: 2.5 }
);
```

Road effects invalidate cached/current routes through road versioning, so active journeys automatically replan when the temporary state changes. Junction radii, obstacles and road effects are included in the current internal snapshot format.


## Fuzzing, determinism and state hashes

The hardening suite includes deterministic randomized tests for graph mutation, route validity, entity lifecycle churn, steering, spatial queries, temporary road effects, obstacles and save/load round-trips.

For longer runs:

```bash
npm run bench:determinism
```

The default determinism soak runs two identical simulations through the same scripted graph mutations, reroutes, obstacle changes and road effects. One simulation is serialized and restored mid-run. State hashes are compared at regular checkpoints and report whether a divergence is in navigation, world configuration or entities.

```js
import {
  computeWorldCoreStateHash,
  computeWorldCoreStateHashes
} from "world-core";
```

State hashes are canonicalized so object key order and route object-sharing details do not create false mismatches. Entity and active-mover execution order are included because they can affect future simulation behavior.


## Snapshot validation and performance

`validateWorldCoreSnapshot(snapshot)` validates a versioned save before restore mutates any reconstructed world state. It checks graph/entity/route references, route continuity, execution order, active journeys, obstacle geometry, road effects, LOD state, coordinates, radii and other numeric bounds.

```bash
npm run bench:snapshot
```

The default snapshot benchmark builds 50,000 entities with 20,000 active journeys and reports separate timings for snapshot creation, JSON encoding, JSON parsing, validation, restore and state-hash verification. It also reports JSON size and post-GC retained-memory deltas for each phase.


## Runtime memory bounds

Transient event capture is bounded independently of the simulation state. The default queue limit is 10,000 events with a `drop-newest` overflow policy; callers may choose `drop-oldest` or `throw`.

```js
const world = new World({
  captureEvents: true,
  eventQueueLimit: 5000,
  eventOverflowPolicy: "drop-newest"
});

console.log(world.getEventQueueStats());
```

Dropped-event counts are exposed for diagnostics. Event queue configuration is persisted, but pending events and drop counters remain transient.

Movement scheduler buckets are also reclaimed as soon as their last entity leaves. Repeatedly assigning unique coarse-movement intervals therefore does not retain empty bucket/accumulator state. Route caches remain bounded by both route count and total cached legs.


## Performance regression guardrails

```bash
npm run bench:guardrails
```

Guardrails deliberately use broad failure thresholds derived from the current full-scale GitHub Actions measurements. They are intended to catch catastrophic regressions rather than normal hosted-runner variance: 50k/20k movement p99 above 150 ms, churn heap above 512 MiB, RSS above 768 MiB, snapshot JSON above 64 MiB, snapshot validation above 1 s, restore above 3 s, 5k local-steering p99 above 75 ms, or steering cost above 50x the centerline baseline.

Thresholds can be overridden with `GUARDRAIL_*` environment variables. CI uses `GUARDRAIL_FAST=1` only to verify the harness and parsers; the manual Performance workflow runs the full workloads.


## TypeScript and consumer example

The package ships first-party declarations through `src/index.d.ts`; no runtime TypeScript dependency is required. Public navigation node, road and destination IDs are non-empty strings. Entity and obstacle IDs may be strings or numbers.

A package-level consumer example exercises the same public surface an external game would use:

```bash
npm run example:mini-city
```

It builds a small street graph, enables crowd steering, adds a market obstacle, applies and clears a temporary road closure, serializes/restores mid-simulation and drains movement events. The matching integration test imports only from `"world-core"`, so internal implementation imports cannot hide gaps in the published API.


## Hierarchical routing and simulation regions

Navigation regions partition large graphs without replacing the exact node/road model. Cross-region roads automatically define gateway nodes.

```js
navigation.addRegion({ id: "luebeck" });
navigation.addRegion({ id: "hamburg" });

navigation.addNode({
  id: "luebeck-market",
  x: 0,
  y: 0,
  regionId: "luebeck"
});

navigation.addNode({
  id: "hamburg-gate",
  x: 10000,
  y: 0,
  regionId: "hamburg"
});

const route = navigation.findHierarchicalRoute(
  "luebeck-market",
  "hamburg-gate",
  mobilityProfile("pedestrian")
);
```

`findHierarchicalRoute()` builds an overlay from regional gateway nodes. Travel inside each region is refined with an exact region-constrained A* route, while cross-region roads connect the overlay. The resulting route is still a normal `Route` and can be consumed by the existing movement system. Regional and final hierarchical routes have independent bounded caches and are invalidated on graph, road-effect, or region-membership changes.

World simulation regions are spatial AABBs used for simulation detail policy rather than pathfinding:

```js
const world = new World({
  simulationRegions: [
    {
      id: "player-city",
      minX: 0,
      minY: 0,
      maxX: 2000,
      maxY: 2000,
      priority: 10,
      detailLevel: "full",
      movementInterval: 0
    },
    {
      id: "distant-city",
      minX: 10000,
      minY: 0,
      maxX: 12000,
      maxY: 2000,
      detailLevel: "background",
      movementInterval: 30
    }
  ]
});
```

Overlapping simulation regions resolve deterministically by higher priority, then smaller area, then region ID. A region's `movementInterval` feeds directly into the existing movement scheduler; `null` falls back to distance LOD and `0` means full-rate movement. Consumers can query `simulationRegionAt(position)` or `getEntitySimulationRegion(id)` for their own AI/economy detail policies.

Navigation regions and world simulation regions are intentionally separate layers. A consumer may use the same IDs for both, but the core does not force graph partitions to match spatial simulation policy. Both are persisted in the current internal snapshot format. Until world-core has real savegame consumers, that format remains v1 and may evolve without compatibility guarantees.
