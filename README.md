# world-core

A rendering-independent 2D world, navigation and movement simulation core.

The world stores actual entity coordinates. Navigation is a separate graph used to plan routes; movement advances entities through world space and keeps the dynamic spatial index synchronized.

## Scalability model

- `World.entities` is the master entity registry.
- Active movement is tracked separately from the full population.
- Movement advances numeric `x/y` state without temporary Vec2 allocations and commits each entity position at most once per processed movement update.
- Movement LOD supports full-detail nearby movers and coarse scheduled updates for distant movers. A far entity can analytically traverse many road points in one scheduled update instead of being touched every simulation tick.
- Dynamic entity lookups use a spatial hash. Moving inside the same occupied cell range does not rewrite hash buckets.
- Reusable spatial query buffers are available through `createSpatialQueryBuffer()` and `queryRadiusInto()`.
- `maxEntityRadius` is tracked with reference counts and shrinks when large entities are removed or resized.
- Navigation nodes and roads use static spatial indexes for local `nodeAt`, `nearestNode` and `roadAt` queries.
- Long road segments are indexed along traversed grid cells rather than filling their entire bounding box.
- Routing uses A* with a binary min-heap rather than an O(V^2) full scan.
- Cached routes contain only road IDs and direction flags, not duplicated road geometry.
- Mobility profiles have stable `profileId` values such as `pedestrian`, `cart` and `horse`.
- The route cache is bounded, rejects routes above `routeCacheMaxLegs`, and maintains reverse road-to-cache indexes.
- Local topology changes invalidate only the affected connected component. `invalidateRoadRoutes()` can invalidate only routes using a road when a change cannot create a better alternative.
- Journeys can start and re-route while an entity is already in the middle of a road.
- `nearestNode()` consistently returns a node; `nearestNodeWithDistance()` returns node plus distance.

## Movement LOD

LOD is optional. Without tiers, movers retain full update frequency.

```js
const world = new World({
  movementLodTiers: [
    { maxDistance: 500, interval: 0 },
    { maxDistance: 5000, interval: 5 },
    { maxDistance: Infinity, interval: 60 }
  ],
  interestPoints: [{ x: 0, y: 0 }]
});
```

An `interval` of `0` means every simulation step. Larger intervals are scheduled in coarse batches; when due, movement is advanced analytically by the accumulated simulated time.

## Allocation-free repeated spatial queries

```js
const buffer = world.createSpatialQueryBuffer();

const nearby = world.queryRadiusInto(
  entity.position,
  8,
  buffer,
  { excludeId: entity.id }
);
```

The convenience `queryRadius()` method remains available when allocation pressure does not matter.

## Commands

```bash
npm start
npm test
npm run bench
npm run bench:soak
```

The standard benchmark builds 20 separate 20x20 city grids (8,000 navigation nodes and 15,200 roads) with curved multi-waypoint streets and mixed surfaces, performs cold and warm A* route batches, creates 50,000 entities, and runs 15,000 active movers by default.

It reports p50, p95, p99 and max tick latency, heap/RSS start/end/peak, GC count and pause statistics, route-cache size/leg count, static road-index memberships, and buffered local-query throughput.

The soak benchmark uses the same workload with a much longer run and a higher default mover count. Benchmark sizes can also be overridden with `BENCH_*` environment variables.
