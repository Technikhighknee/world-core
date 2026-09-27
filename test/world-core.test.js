import assert from "node:assert/strict";
import test from "node:test";

import { mobilityProfile } from "../src/world/mobility-profiles.js";
import { Navigation } from "../src/world/navigation.js";
import {
    rerouteJourney,
    startJourney,
    stopJourney,
} from "../src/world/movement.js";
import { stepSimulation } from "../src/world/simulation.js";
import { SpatialHash } from "../src/world/spatial-hash.js";
import { StaticSpatialIndex } from "../src/world/static-spatial-index.js";
import { World } from "../src/world/world.js";

function buildLineNavigation(length = 100) {
    const navigation = new Navigation({ spatialCellSize: 10 });
    navigation.addNode({ id: "a", x: 0, y: 0 });
    navigation.addNode({ id: "b", x: length, y: 0 });
    navigation.addRoad({ id: "road", from: "a", to: "b", width: 4 });
    return navigation;
}

test("spatial hash keeps queries correct while entities move within and across cells", () => {
    const spatial = new SpatialHash(10);

    spatial.upsert("person", { x: 1, y: 1 }, 0.35);
    assert.deepEqual([...spatial.queryRadius({ x: 1, y: 1 }, 1)], ["person"]);

    const rangeBefore = spatial.entityRanges.get("person");
    const changedWithinCell = spatial.upsert("person", { x: 2, y: 2 }, 0.35);

    assert.equal(changedWithinCell, false);
    assert.strictEqual(
        spatial.entityRanges.get("person"),
        rangeBefore,
    );

    const changedAcrossCell = spatial.upsert("person", { x: 21, y: 2 }, 0.35);
    assert.equal(changedAcrossCell, true);
    assert.equal(spatial.queryRadius({ x: 1, y: 1 }, 1).has("person"), false);
    assert.equal(spatial.queryRadius({ x: 21, y: 2 }, 1).has("person"), true);
});

test("spatial queries can reuse caller-owned buffers", () => {
    const world = new World({ spatialCellSize: 10 });

    world.addEntity({ id: "a", position: { x: 0, y: 0 } });
    world.addEntity({ id: "b", position: { x: 3, y: 0 } });

    const buffer = world.createSpatialQueryBuffer();
    const candidates = buffer.candidates;
    const results = buffer.results;

    const first = world.queryRadiusInto({ x: 0, y: 0 }, 5, buffer);
    const second = world.queryRadiusInto({ x: 3, y: 0 }, 5, buffer);

    assert.strictEqual(first, results);
    assert.strictEqual(second, results);
    assert.strictEqual(buffer.candidates, candidates);
});

test("maxEntityRadius shrinks again when the largest entity is removed", () => {
    const world = new World();

    world.addEntity({
        id: "small",
        position: { x: 0, y: 0 },
        body: { radius: 0.5 },
    });

    world.addEntity({
        id: "large",
        position: { x: 0, y: 0 },
        body: { radius: 10 },
    });

    assert.equal(world.maxEntityRadius, 10);

    world.removeEntity("large");

    assert.equal(world.maxEntityRadius, 0.5);
});

test("only active movers are tracked and completed journeys leave the active set", () => {
    const world = new World({ spatialCellSize: 10 });
    const navigation = buildLineNavigation(10);

    for (let i = 0; i < 1000; i++) {
        world.addEntity({
            id: `idle-${i}`,
            kind: "person",
            position: { x: 1000 + i, y: 1000 },
        });
    }

    world.addEntity({
        id: "walker",
        kind: "person",
        position: { x: 0, y: 0 },
        mobility: { speed: 2 },
    });

    startJourney(world, navigation, "walker", "b");

    assert.equal(world.entities.size, 1001);
    assert.equal(world.movingEntities.size, 1);
    assert.equal(world.entityMovementIntervals.size, 0);
    assert.equal(world.movementBuckets.size, 0);

    stepSimulation(world, navigation, 10);

    assert.deepEqual(world.getEntity("walker").position, { x: 10, y: 0 });
    assert.equal(world.movingEntities.size, 0);
    assert.equal(world.getEntity("walker").journey, null);
});

test("stopJourney can immediately remove an entity from the moving set", () => {
    const world = new World();
    const navigation = buildLineNavigation();

    const walker = world.addEntity({
        id: "walker",
        position: { x: 0, y: 0 },
        mobility: { speed: 1 },
    });

    startJourney(world, navigation, "walker", "b");
    assert.equal(world.movingEntities.has("walker"), true);

    stopJourney(walker, world);
    assert.equal(world.movingEntities.has("walker"), false);
});

test("movement commits position to the spatial index once per entity tick", () => {
    const world = new World({ spatialCellSize: 5 });
    const navigation = new Navigation({ spatialCellSize: 5 });

    navigation.addNode({ id: "a", x: 0, y: 0 });
    navigation.addNode({ id: "b", x: 100, y: 0 });
    navigation.addRoad({
        id: "waypoint-heavy",
        from: "a",
        to: "b",
        shape: Array.from({ length: 99 }, (_, index) => ({
            x: index + 1,
            y: index % 2 === 0 ? 0.2 : -0.2,
        })),
    });

    world.addEntity({
        id: "walker",
        position: { x: 0, y: 0 },
        mobility: { speed: 200 },
    });

    let commits = 0;
    const originalSetEntityPositionXY =
        world.setEntityPositionXY.bind(world);

    world.setEntityPositionXY = (...args) => {
        commits++;
        return originalSetEntityPositionXY(...args);
    };

    startJourney(world, navigation, "walker", "b");
    stepSimulation(world, navigation, 1);

    assert.equal(commits, 1);
    assert.equal(world.getEntity("walker").journey, null);
    assert.deepEqual(world.getEntity("walker").position, { x: 100, y: 0 });
});

test("journeys can start and reroute while already in the middle of a road", () => {
    const world = new World({ spatialCellSize: 10 });
    const navigation = buildLineNavigation(100);

    world.addEntity({
        id: "walker",
        position: { x: 40, y: 0 },
        mobility: { speed: 1 },
    });

    assert.equal(startJourney(world, navigation, "walker", "b"), true);

    stepSimulation(world, navigation, 10);
    assert.equal(world.getEntity("walker").position.x, 50);

    assert.equal(rerouteJourney(world, navigation, "walker", "a"), true);

    stepSimulation(world, navigation, 10);
    assert.equal(world.getEntity("walker").position.x, 40);
});

test("cached routes store road references instead of duplicated road geometry", () => {
    const navigation = new Navigation({ routeCacheSize: 10 });

    navigation.addNode({ id: "a", x: 0, y: 0 });
    navigation.addNode({ id: "b", x: 100, y: 0 });
    navigation.addRoad({
        id: "road",
        from: "a",
        to: "b",
        shape: [{ x: 25, y: 1 }, { x: 50, y: -1 }, { x: 75, y: 1 }],
    });

    const route = navigation.findRoute("a", "b", {
        profileId: "pedestrian-test",
        speed: 1,
    });

    assert.deepEqual(route.legs, [{ roadId: "road", reversed: false }]);
    assert.equal("points" in route.legs[0], false);
});

test("navigation uses indexed node and road lookups with consistent nearestNode return shape", () => {
    const navigation = new Navigation({ spatialCellSize: 10 });

    navigation.addNode({ id: "a", x: 0, y: 0 });
    navigation.addNode({ id: "b", x: 100, y: 0 });
    navigation.addRoad({
        id: "curved",
        from: "a",
        to: "b",
        width: 6,
        shape: [{ x: 50, y: 10 }],
    });

    assert.equal(navigation.nodeAt({ x: 0.05, y: 0 }, 0.1)?.id, "a");
    assert.equal(navigation.nearestNode({ x: 90, y: 0 })?.id, "b");
    assert.equal(
        navigation.nearestNodeWithDistance({ x: 90, y: 0 })?.node.id,
        "b",
    );
    assert.equal(navigation.roadAt({ x: 50, y: 10 })?.road.id, "curved");
    assert.equal(navigation.roadAt({ x: 50, y: 30 }), null);
});

test("A* finds the faster route and route results are cached", () => {
    const navigation = new Navigation({ routeCacheSize: 10 });

    navigation.addNode({ id: "a", x: 0, y: 0 });
    navigation.addNode({ id: "b", x: 10, y: 0 });
    navigation.addNode({ id: "c", x: 20, y: 0 });
    navigation.addNode({ id: "d", x: 10, y: 10 });

    navigation.addRoad({ id: "ab", from: "a", to: "b", surface: "mud" });
    navigation.addRoad({ id: "bc", from: "b", to: "c", surface: "mud" });
    navigation.addRoad({ id: "ad", from: "a", to: "d", surface: "street" });
    navigation.addRoad({ id: "dc", from: "d", to: "c", surface: "street" });

    const mobility = {
        profileId: "test-pedestrian",
        speed: 1,
        surfaceMultipliers: {
            mud: 0.25,
            street: 1,
        },
    };

    const first = navigation.findRoute("a", "c", mobility);
    const second = navigation.findRoute("a", "c", {
        ...mobility,
        surfaceMultipliers: { ...mobility.surfaceMultipliers },
    });

    assert.deepEqual(first.legs.map(leg => leg.roadId), ["ad", "dc"]);
    assert.strictEqual(first, second);
    assert.equal(navigation.routeCache.size, 1);
});

test("local graph changes do not invalidate cached routes in disconnected components", () => {
    const navigation = new Navigation({ routeCacheSize: 10 });
    const mobility = { profileId: "walker", speed: 1 };

    navigation.addNode({ id: "a", x: 0, y: 0 });
    navigation.addNode({ id: "b", x: 10, y: 0 });
    navigation.addRoad({ id: "ab", from: "a", to: "b" });

    navigation.addNode({ id: "x", x: 1000, y: 0 });
    navigation.addNode({ id: "y", x: 1010, y: 0 });
    navigation.addRoad({ id: "xy", from: "x", to: "y" });

    const ab = navigation.findRoute("a", "b", mobility);
    const xy = navigation.findRoute("x", "y", mobility);

    assert.equal(navigation.routeCache.size, 2);

    navigation.addNode({ id: "c", x: 20, y: 0 });
    navigation.addRoad({ id: "bc", from: "b", to: "c" });

    assert.equal(navigation.routeCache.size, 1);
    assert.strictEqual(navigation.findRoute("x", "y", mobility), xy);
    assert.notStrictEqual(navigation.findRoute("a", "b", mobility), ab);
});

test("built-in mobility profiles expose stable cache identities", () => {
    const pedestrian = mobilityProfile("pedestrian");
    const cloned = structuredClone(pedestrian);

    assert.equal(pedestrian.profileId, "pedestrian");
    assert.equal(cloned.profileId, "pedestrian");
    assert.equal(pedestrian.speed, cloned.speed);
});

test("long roads are indexed along their traversed cells instead of their full bounding box", () => {
    const index = new StaticSpatialIndex(10);

    index.insertSegment(
        "diagonal",
        { x: 0, y: 0 },
        { x: 1000, y: 1000 },
    );

    assert.ok(index.membershipCount() < 400);
    assert.equal(index.queryPoint({ x: 500, y: 500 }).has("diagonal"), true);
});

test("movement LOD advances distant movers in coarse scheduled steps", () => {
    const world = new World({
        movementLodTiers: [
            { maxDistance: 100, interval: 0 },
            { maxDistance: Infinity, interval: 10 },
        ],
        interestPoints: [{ x: 0, y: 0 }],
    });

    const navigation = new Navigation();
    navigation.addNode({ id: "a", x: 1000, y: 0 });
    navigation.addNode({ id: "b", x: 1200, y: 0 });
    navigation.addRoad({ id: "road", from: "a", to: "b" });

    world.addEntity({
        id: "far-walker",
        position: { x: 1000, y: 0 },
        mobility: { speed: 1 },
    });

    startJourney(world, navigation, "far-walker", "b");

    for (let i = 0; i < 9; i++) {
        stepSimulation(world, navigation, 1);
    }

    assert.equal(world.getEntity("far-walker").position.x, 1000);

    stepSimulation(world, navigation, 1);
    assert.equal(world.getEntity("far-walker").position.x, 1010);

    world.setInterestPoints([{ x: 1010, y: 0 }]);
    stepSimulation(world, navigation, 1);

    assert.equal(world.getEntity("far-walker").position.x, 1011);
});

test("nearby queries ignore thousands of far-away entities", () => {
    const world = new World({ spatialCellSize: 10 });

    world.addEntity({ id: "thief", position: { x: 0, y: 0 } });
    world.addEntity({ id: "target", position: { x: 3, y: 0 } });

    for (let i = 0; i < 5000; i++) {
        world.addEntity({
            id: `far-${i}`,
            position: { x: 10000 + i, y: 10000 },
        });
    }

    const buffer = world.createSpatialQueryBuffer();
    const nearby = world.queryRadiusInto(
        { x: 0, y: 0 },
        5,
        buffer,
        { excludeId: "thief" },
    );

    assert.deepEqual(nearby.map(entity => entity.id), ["target"]);
});


test("frozen mobility profiles are shared instead of cloned per entity", () => {
    const world = new World();
    const pedestrian = mobilityProfile("pedestrian");

    world.addEntity({
        id: "a",
        position: { x: 0, y: 0 },
        mobility: pedestrian,
    });

    world.addEntity({
        id: "b",
        position: { x: 1, y: 0 },
        mobility: pedestrian,
    });

    assert.strictEqual(world.getEntity("a").mobility, pedestrian);
    assert.strictEqual(world.getEntity("b").mobility, pedestrian);
    assert.strictEqual(
        world.getEntity("a").mobility,
        world.getEntity("b").mobility,
    );
});

test("route cache is bounded by total retained legs", () => {
    const navigation = new Navigation({
        routeCacheSize: 100,
        routeCacheMaxLegs: 100,
        routeCacheMaxTotalLegs: 3,
    });

    for (let i = 0; i < 5; i++) {
        navigation.addNode({ id: `n${i}`, x: i * 10, y: 0 });

        if (i > 0) {
            navigation.addRoad({
                id: `r${i - 1}`,
                from: `n${i - 1}`,
                to: `n${i}`,
            });
        }
    }

    const mobility = { profileId: "test", speed: 1 };

    navigation.findRoute("n0", "n2", mobility);
    navigation.findRoute("n1", "n4", mobility);

    assert.ok(navigation.routeCacheLegCount <= 3);
    assert.ok(navigation.routeCache.size <= 1);

    navigation.invalidateAllRoutes();

    assert.equal(navigation.routeCache.size, 0);
    assert.equal(navigation.routeCacheLegCount, 0);
});

test("removing a moving entity clears movement scheduler state", () => {
    const world = new World({
        movementLodTiers: [
            { maxDistance: Infinity, interval: 10 },
        ],
        interestPoints: [{ x: 0, y: 0 }],
    });
    const navigation = buildLineNavigation(100);

    world.addEntity({
        id: "walker",
        position: { x: 0, y: 0 },
        mobility: { speed: 1 },
    });

    startJourney(world, navigation, "walker", "b");

    const walker = world.getEntity("walker");

    assert.equal(world.movingEntities.has("walker"), true);
    assert.strictEqual(world.movingEntities.get("walker"), walker);
    assert.equal(world.entityMovementIntervals.has("walker"), true);

    world.removeEntity("walker");

    assert.equal(world.movingEntities.has("walker"), false);
    assert.equal(world.entityMovementIntervals.has("walker"), false);

    for (const bucket of world.movementBuckets.values()) {
        assert.equal(bucket.has(walker), false);
    }
});


test("world diagnostics detect and report consistent index membership", () => {
    const world = new World({ spatialCellSize: 10 });
    const navigation = buildLineNavigation(100);

    world.addEntity({
        id: "walker",
        position: { x: 0, y: 0 },
        mobility: { speed: 1 },
    });

    world.addEntity({
        id: "idle",
        position: { x: 20, y: 20 },
    });

    startJourney(world, navigation, "walker", "b");

    const diagnostics = world.assertInternalConsistency();

    assert.equal(diagnostics.entityCount, 2);
    assert.equal(diagnostics.spatialIndexedEntities, 2);
    assert.equal(diagnostics.movingEntities, 1);
    assert.equal(diagnostics.movementIntervalEntries, 0);
    assert.equal(diagnostics.movementBucketMemberships, 0);
    assert.equal(diagnostics.radiusTrackedEntities, 2);

    world.removeEntity("walker");
    world.removeEntity("idle");

    const empty = world.assertInternalConsistency();

    assert.equal(empty.entityCount, 0);
    assert.equal(empty.spatialIndexedEntities, 0);
    assert.equal(empty.movingEntities, 0);
    assert.equal(empty.movementIntervalEntries, 0);
    assert.equal(empty.movementBucketMemberships, 0);
    assert.equal(empty.radiusTrackedEntities, 0);
});


test("mid-road journeys share cached base routes instead of copying route legs", () => {
    const world = new World({ spatialCellSize: 10 });
    const navigation = new Navigation({ routeCacheSize: 100 });

    navigation.addNode({ id: "a", x: 0, y: 0 });
    navigation.addNode({ id: "b", x: 100, y: 0 });
    navigation.addNode({ id: "c", x: 200, y: 0 });

    navigation.addRoad({
        id: "ab",
        from: "a",
        to: "b",
        shape: [
            { x: 25, y: 0 },
            { x: 50, y: 0 },
            { x: 75, y: 0 },
        ],
    });

    navigation.addRoad({
        id: "bc",
        from: "b",
        to: "c",
    });

    const mobility = {
        profileId: "mid-road-test",
        speed: 1,
    };

    world.addEntity({
        id: "one",
        position: { x: 40, y: 0 },
        mobility,
    });

    world.addEntity({
        id: "two",
        position: { x: 60, y: 0 },
        mobility,
    });

    assert.equal(startJourney(world, navigation, "one", "c"), true);
    assert.equal(startJourney(world, navigation, "two", "c"), true);

    const one = world.getEntity("one").journey;
    const two = world.getEntity("two").journey;

    assert.strictEqual(one.route, two.route);
    assert.deepEqual(one.route.legs, [
        { roadId: "bc", reversed: false },
    ]);
    assert.equal(one.prefixLeg.roadId, "ab");
    assert.equal(two.prefixLeg.roadId, "ab");
    assert.notStrictEqual(one.prefixLeg, two.prefixLeg);
});

test("dynamic movement LOD schedules movers while default movement does not", () => {
    const fullRateWorld = new World();
    const navigation = buildLineNavigation(100);

    fullRateWorld.addEntity({
        id: "full-rate",
        position: { x: 0, y: 0 },
        mobility: { speed: 1 },
    });

    startJourney(fullRateWorld, navigation, "full-rate", "b");

    assert.equal(fullRateWorld.movingEntities.size, 1);
    assert.equal(fullRateWorld.entityMovementIntervals.size, 0);
    assert.equal(fullRateWorld.movementBuckets.size, 0);

    const lodWorld = new World({
        movementLodTiers: [
            { maxDistance: 10, interval: 0 },
            { maxDistance: Infinity, interval: 10 },
        ],
        interestPoints: [{ x: 1000, y: 0 }],
    });

    lodWorld.addEntity({
        id: "lod",
        position: { x: 0, y: 0 },
        mobility: { speed: 1 },
    });

    startJourney(lodWorld, navigation, "lod", "b");

    assert.equal(lodWorld.movingEntities.size, 1);
    assert.equal(lodWorld.entityMovementIntervals.get("lod"), 10);
    assert.equal(
        lodWorld.movementBuckets
            .get(10)
            ?.has(lodWorld.getEntity("lod")),
        true,
    );
});


test("dynamic spatial cells collapse back to singleton storage", () => {
    const spatial = new SpatialHash(10);

    spatial.upsert("a", { x: 5, y: 5 }, 0);
    assert.equal(
        [...spatial.cells.values()].some(cell => cell instanceof Set),
        false,
    );

    spatial.upsert("b", { x: 6, y: 5 }, 0);
    assert.equal(
        [...spatial.cells.values()].some(cell => cell instanceof Set),
        true,
    );

    spatial.remove("b");

    assert.equal(spatial.queryRadius({ x: 5, y: 5 }, 1).has("a"), true);
    assert.equal(
        [...spatial.cells.values()].some(cell => cell instanceof Set),
        false,
    );
});

test("static point memberships avoid per-item and per-cell sets when singleton", () => {
    const index = new StaticSpatialIndex(10);

    index.insertPoint("a", { x: 5, y: 5 });
    index.insertPoint("b", { x: 25, y: 5 });

    assert.equal(index.itemCells.get("a") instanceof Set, false);
    assert.equal(index.itemCells.get("b") instanceof Set, false);
    assert.equal(index.multiOccupancyCellCount(), 0);

    assert.equal(index.queryPoint({ x: 5, y: 5 }).has("a"), true);
    assert.equal(index.queryPoint({ x: 25, y: 5 }).has("b"), true);
});

test("roadAt finds road width across a spatial cell boundary without padded indexing", () => {
    const navigation = new Navigation({ spatialCellSize: 10 });

    navigation.addNode({ id: "a", x: 0, y: 9 });
    navigation.addNode({ id: "b", x: 100, y: 9 });
    navigation.addRoad({
        id: "boundary-road",
        from: "a",
        to: "b",
        width: 4,
    });

    const hit = navigation.roadAt({ x: 50, y: 10.5 });

    assert.equal(hit?.road.id, "boundary-road");
    assert.ok(hit.distance <= 2);
});


test("world spatial index stores dynamic entities by center only", () => {
    const world = new World({ spatialCellSize: 10 });

    world.addEntity({
        id: "large",
        position: { x: 9.9, y: 9.9 },
        body: { radius: 5 },
    });

    const diagnostics = world.assertInternalConsistency();

    assert.equal(diagnostics.entityCount, 1);
    assert.equal(diagnostics.spatialIndexedEntities, 1);
    assert.equal(diagnostics.spatialMemberships, 1);
});

test("center-only world indexing still finds bodies intersecting a radius query", () => {
    const world = new World({ spatialCellSize: 10 });

    world.addEntity({
        id: "large",
        position: { x: 20, y: 0 },
        body: { radius: 10 },
    });

    const nearby = world.queryRadius(
        { x: 0, y: 0 },
        10,
    );

    assert.deepEqual(nearby.map(entity => entity.id), ["large"]);
});

test("changing entity radius does not rewrite its center cell", () => {
    const world = new World({ spatialCellSize: 10 });

    world.addEntity({
        id: "person",
        position: { x: 5, y: 5 },
        body: { radius: 0.35 },
    });

    const range = world.spatial.entityRanges.get("person");

    world.setEntityRadius("person", 25);

    assert.strictEqual(
        world.spatial.entityRanges.get("person"),
        range,
    );
    assert.equal(world.maxEntityRadius, 25);
    assert.equal(world.spatial.membershipCount(), 1);
});
