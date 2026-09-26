# world-core

A rendering-independent 2D world, navigation and movement simulation core.

The world stores actual entity coordinates. Navigation is a separate graph used to plan routes; movement advances entities through world space and keeps the dynamic spatial index synchronized.

## Scalability model

- `World.entities` is the master entity registry.
- `World.movingEntities` contains only entities currently moving, so movement cost scales with active movers rather than total population.
- Dynamic entity lookups use a spatial hash. Moving inside the same occupied cell range does not rewrite hash buckets.
- Navigation nodes and roads use static spatial indexes for local `nodeAt`, `nearestNode` and `roadAt` queries.
- Routing uses A* with a binary min-heap rather than a full `O(V²)` scan.
- Identical routes are cached with a bounded LRU-style cache and shared by journeys.
- Distant cities do not add cost to local spatial queries because only overlapping hash cells are inspected.

## Commands

```bash
npm start
npm test
npm run bench
```

The benchmark creates 50,000 entities across 20 distant cities, with 5,000 entities moving simultaneously, then runs movement ticks and repeated local proximity queries.
