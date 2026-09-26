# world-core

A rendering-independent 2D world, navigation and movement simulation core.

The world stores actual entity coordinates. Navigation is a separate graph used to plan routes; movement advances entities through world space and keeps the dynamic spatial index synchronized.

## Scalability model

- `World.entities` is the master entity registry.
- `World.movingEntities` contains only entities currently moving, so movement cost scales with active movers rather than total population.
- Movement advances local numeric `x/y` state without temporary Vec2 allocations in the hot loop and commits each entity position at most once per simulation tick.
- Dynamic entity lookups use a spatial hash. Moving inside the same occupied cell range does not rewrite hash buckets.
- Navigation nodes and roads use static spatial indexes for local `nodeAt`, `nearestNode` and `roadAt` queries.
- Routing uses A* with a binary min-heap rather than a full `O(V²)` scan.
- Mobility profiles have stable `profileId` values such as `pedestrian`, `cart` and `horse`; the profile ID is used directly in route-cache keys.
- Custom mobility objects still work. Without `profileId` or `cacheKey`, a deterministic fallback key is generated from their values.
- Identical routes are cached with a bounded LRU-style cache and shared by journeys.
- Distant cities do not add cost to local spatial queries because only overlapping hash cells are inspected.

## Commands

```bash
npm start
npm test
npm run bench
```

The scalability benchmark is deliberately non-trivial. It builds 20 separate 20×20 city grids (8,000 navigation nodes and 15,200 roads) with curved multi-waypoint streets and mixed surfaces, executes cold and warm A* route queries, creates 50,000 entities, moves 5,000 of them simultaneously across long multi-road routes, and runs repeated local proximity queries.
