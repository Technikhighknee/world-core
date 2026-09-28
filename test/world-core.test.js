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
import {
    computeWorldCoreStateHash,
} from "../src/world/state-hash.js";
import {
    deserializeWorldCore,
    serializeWorldCore,
} from "../src/world/serialization.js";
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

    assert.deepEqual(route.legs, [{
        roadId: "road",
        reversed: false,
        roadVersion: 1,
    }]);
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
        {
            roadId: "bc",
            reversed: false,
            roadVersion: 1,
        },
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


test("deterministic A* chooses the same equal-cost route regardless of road insertion order", () => {
    function build(order) {
        const navigation = new Navigation();

        navigation.addNode({ id: "a", x: 0, y: 0 });
        navigation.addNode({ id: "b", x: 10, y: -10 });
        navigation.addNode({ id: "c", x: 10, y: 10 });
        navigation.addNode({ id: "d", x: 20, y: 0 });

        const roads = {
            ab: { id: "ab", from: "a", to: "b" },
            bd: { id: "bd", from: "b", to: "d" },
            ac: { id: "ac", from: "a", to: "c" },
            cd: { id: "cd", from: "c", to: "d" },
        };

        for (const id of order) {
            navigation.addRoad(roads[id]);
        }

        return navigation;
    }

    const mobility = {
        profileId: "deterministic",
        speed: 1,
    };

    const first = build(["ab", "bd", "ac", "cd"])
        .findRoute("a", "d", mobility);
    const second = build(["cd", "ac", "bd", "ab"])
        .findRoute("a", "d", mobility);

    assert.deepEqual(
        first.legs.map(leg => leg.roadId),
        second.legs.map(leg => leg.roadId),
    );
});

test("identical simulation inputs produce identical movement state", () => {
    function run() {
        const world = new World({ spatialCellSize: 10 });
        const navigation = new Navigation();

        navigation.addNode({ id: "a", x: 0, y: 0 });
        navigation.addNode({ id: "b", x: 100, y: 20 });
        navigation.addNode({ id: "c", x: 200, y: 0 });

        navigation.addRoad({
            id: "ab",
            from: "a",
            to: "b",
            shape: [
                { x: 25, y: 5 },
                { x: 50, y: 15 },
                { x: 75, y: 10 },
            ],
        });

        navigation.addRoad({
            id: "bc",
            from: "b",
            to: "c",
            shape: [
                { x: 125, y: 10 },
                { x: 150, y: 0 },
                { x: 175, y: 5 },
            ],
        });

        world.addEntity({
            id: "walker",
            position: { x: 0, y: 0 },
            mobility: {
                profileId: "deterministic-walker",
                speed: 1.3,
            },
        });

        startJourney(world, navigation, "walker", "c");

        for (let i = 0; i < 137; i++) {
            stepSimulation(world, navigation, 0.5);
        }

        return structuredClone({
            time: world.time,
            entity: world.getEntity("walker"),
        });
    }

    assert.deepEqual(run(), run());
});

test("road constraints filter routes by profile width and tags", () => {
    const navigation = new Navigation();

    navigation.addNode({ id: "a", x: 0, y: 0 });
    navigation.addNode({ id: "b", x: 10, y: 0 });
    navigation.addNode({ id: "c", x: 20, y: 0 });
    navigation.addNode({ id: "d", x: 10, y: 10 });

    navigation.addRoad({
        id: "narrow",
        from: "a",
        to: "b",
        width: 1,
        allowedProfiles: ["pedestrian"],
    });
    navigation.addRoad({
        id: "narrow-2",
        from: "b",
        to: "c",
        width: 1,
        allowedProfiles: ["pedestrian"],
    });
    navigation.addRoad({
        id: "wide",
        from: "a",
        to: "d",
        width: 4,
        tags: ["cart-road"],
    });
    navigation.addRoad({
        id: "wide-2",
        from: "d",
        to: "c",
        width: 4,
        tags: ["cart-road"],
    });

    const pedestrian = {
        profileId: "pedestrian",
        speed: 1,
    };
    const cart = {
        profileId: "cart",
        speed: 1,
        requiredRoadWidth: 2,
        requiredRoadTags: ["cart-road"],
    };

    assert.deepEqual(
        navigation.findRoute("a", "c", pedestrian)
            .legs.map(leg => leg.roadId),
        ["narrow", "narrow-2"],
    );

    assert.deepEqual(
        navigation.findRoute("a", "c", cart)
            .legs.map(leg => leg.roadId),
        ["wide", "wide-2"],
    );
});

test("dynamic road mutations update routing and connected components", () => {
    const navigation = new Navigation();
    const mobility = {
        profileId: "walker",
        speed: 1,
    };

    navigation.addNode({ id: "a", x: 0, y: 0 });
    navigation.addNode({ id: "b", x: 10, y: 0 });
    navigation.addNode({ id: "c", x: 20, y: 0 });

    navigation.addRoad({
        id: "ab",
        from: "a",
        to: "b",
    });
    navigation.addRoad({
        id: "bc",
        from: "b",
        to: "c",
    });

    assert.ok(navigation.findRoute("a", "c", mobility));

    navigation.setRoadEnabled("bc", false);
    assert.equal(navigation.findRoute("a", "c", mobility), null);

    navigation.setRoadEnabled("bc", true);
    assert.ok(navigation.findRoute("a", "c", mobility));

    navigation.removeRoad("bc");
    assert.equal(navigation.findRoute("a", "c", mobility), null);

    navigation.addRoad({
        id: "bc-2",
        from: "b",
        to: "c",
    });
    assert.ok(navigation.findRoute("a", "c", mobility));

    navigation.removeNode("b");

    assert.equal(navigation.nodes.has("b"), false);
    assert.equal(navigation.roads.has("ab"), false);
    assert.equal(navigation.roads.has("bc-2"), false);
    assert.equal(navigation.findRoute("a", "c", mobility), null);
});

test("road geometry width surface access and direction mutations invalidate old route legs", () => {
    const navigation = new Navigation();
    const mobility = {
        profileId: "walker",
        speed: 1,
    };

    navigation.addNode({ id: "a", x: 0, y: 0 });
    navigation.addNode({ id: "b", x: 100, y: 0 });

    navigation.addRoad({
        id: "road",
        from: "a",
        to: "b",
        width: 4,
    });

    const versions = [];

    versions.push(navigation.roads.get("road").version);
    navigation.setRoadWidth("road", 5);
    versions.push(navigation.roads.get("road").version);
    navigation.setRoadSurface("road", "mud");
    versions.push(navigation.roads.get("road").version);
    navigation.setRoadAccess("road", {
        tags: ["public"],
    });
    versions.push(navigation.roads.get("road").version);
    navigation.replaceRoadGeometry("road", [
        { x: 50, y: 20 },
    ]);
    versions.push(navigation.roads.get("road").version);
    navigation.setRoadBidirectional("road", false);
    versions.push(navigation.roads.get("road").version);

    assert.deepEqual(
        versions,
        [1, 2, 3, 4, 5, 6],
    );

    assert.ok(navigation.findRoute("a", "b", mobility));
    assert.equal(navigation.findRoute("b", "a", mobility), null);
    assert.equal(
        navigation.roadAt({ x: 50, y: 20 })?.road.id,
        "road",
    );
});

test("journey automatically replans when a future road becomes stale", () => {
    const world = new World();
    const navigation = new Navigation();

    navigation.addNode({ id: "a", x: 0, y: 0 });
    navigation.addNode({ id: "b", x: 10, y: 0 });
    navigation.addNode({ id: "c", x: 20, y: 0 });
    navigation.addNode({ id: "d", x: 10, y: 10 });

    navigation.addRoad({
        id: "ab",
        from: "a",
        to: "b",
    });
    navigation.addRoad({
        id: "bc",
        from: "b",
        to: "c",
    });
    navigation.addRoad({
        id: "ad",
        from: "a",
        to: "d",
    });
    navigation.addRoad({
        id: "dc",
        from: "d",
        to: "c",
    });

    world.addEntity({
        id: "walker",
        position: { x: 0, y: 0 },
        mobility: {
            profileId: "walker",
            speed: 1,
        },
    });

    assert.equal(
        startJourney(world, navigation, "walker", "c"),
        true,
    );

    navigation.setRoadEnabled("bc", false);

    stepSimulation(world, navigation, 1);

    const journey = world.getEntity("walker").journey;

    assert.ok(journey);
    assert.deepEqual(
        journey.route.legs.map(leg => leg.roadId),
        ["ad", "dc"],
    );
});

test("journey stops with an explicit failure when invalidation leaves no route", () => {
    const world = new World();
    const navigation = buildLineNavigation(100);

    world.addEntity({
        id: "walker",
        position: { x: 0, y: 0 },
        mobility: {
            profileId: "walker",
            speed: 1,
        },
    });

    startJourney(world, navigation, "walker", "b");
    navigation.setRoadEnabled("road", false);

    stepSimulation(world, navigation, 1);

    const walker = world.getEntity("walker");

    assert.equal(walker.journey, null);
    assert.equal(
        walker.lastJourneyFailure.reason,
        "route-invalidated",
    );
    assert.equal(world.movingEntities.has("walker"), false);
});

test("arbitrary-position navigation entry can connect an off-network entity", () => {
    const world = new World();
    const navigation = buildLineNavigation(100);

    world.addEntity({
        id: "walker",
        position: { x: 20, y: 8 },
        mobility: {
            profileId: "walker",
            speed: 1,
        },
    });

    assert.equal(
        startJourney(
            world,
            navigation,
            "walker",
            "b",
            { entryMaxDistance: 10 },
        ),
        true,
    );

    const journey = world.getEntity("walker").journey;

    assert.deepEqual(
        journey.entryPoint,
        { x: 20, y: 0 },
    );

    stepSimulation(world, navigation, 8);

    assert.ok(
        Math.abs(world.getEntity("walker").position.y) <
        1e-9,
    );
});


test("AABB queries include bodies intersecting the box and reuse buffers", () => {
    const world = new World({ spatialCellSize: 10 });

    world.addEntity({
        id: "inside",
        position: { x: 5, y: 5 },
        body: { radius: 0.5 },
    });
    world.addEntity({
        id: "touching",
        position: { x: 11, y: 5 },
        body: { radius: 1 },
    });
    world.addEntity({
        id: "outside",
        position: { x: 20, y: 5 },
        body: { radius: 1 },
    });

    const buffer = world.createSpatialQueryBuffer();
    const first = world.queryAabbInto(
        0,
        0,
        10,
        10,
        buffer,
    );

    assert.strictEqual(first, buffer.results);
    assert.deepEqual(
        first.map(entity => entity.id).sort(),
        ["inside", "touching"],
    );

    const second = world.queryAabbInto(
        15,
        0,
        25,
        10,
        buffer,
    );

    assert.strictEqual(second, buffer.results);
    assert.deepEqual(
        second.map(entity => entity.id),
        ["outside"],
    );
});

test("segment and capsule queries use exact body distance", () => {
    const world = new World({ spatialCellSize: 10 });

    world.addEntity({
        id: "on-line",
        position: { x: 5, y: 0.5 },
        body: { radius: 0.5 },
    });
    world.addEntity({
        id: "capsule-only",
        position: { x: 5, y: 2 },
        body: { radius: 0.5 },
    });
    world.addEntity({
        id: "far",
        position: { x: 5, y: 5 },
        body: { radius: 0.5 },
    });

    const a = { x: 0, y: 0 };
    const b = { x: 10, y: 0 };

    assert.deepEqual(
        world.querySegment(a, b)
            .map(entity => entity.id),
        ["on-line"],
    );

    assert.deepEqual(
        world.queryCapsule(a, b, 1.5)
            .map(entity => entity.id)
            .sort(),
        ["capsule-only", "on-line"],
    );
});

test("nearest query returns body-surface distance with deterministic tie-breaking", () => {
    const world = new World({ spatialCellSize: 10 });

    world.addEntity({
        id: "b",
        position: { x: 5, y: 0 },
        body: { radius: 1 },
    });
    world.addEntity({
        id: "a",
        position: { x: -5, y: 0 },
        body: { radius: 1 },
    });
    world.addEntity({
        id: "far",
        position: { x: 100, y: 0 },
        body: { radius: 1 },
    });

    const nearest = world.queryNearest(
        { x: 0, y: 0 },
        { maxDistance: 10 },
    );

    assert.equal(nearest.entity.id, "a");
    assert.equal(nearest.distance, 4);
    assert.equal(nearest.centerDistance, 5);

    assert.equal(
        world.queryNearest(
            { x: 0, y: 0 },
            {
                maxDistance: 10,
                predicate: entity =>
                    entity.id === "far",
            },
        ),
        null,
    );
});

test("capsule queries honor exclusion and predicates", () => {
    const world = new World();

    world.addEntity({
        id: "self",
        kind: "person",
        position: { x: 1, y: 0 },
    });
    world.addEntity({
        id: "person",
        kind: "person",
        position: { x: 2, y: 0 },
    });
    world.addEntity({
        id: "cart",
        kind: "cart",
        position: { x: 3, y: 0 },
    });

    const results = world.queryCapsule(
        { x: 0, y: 0 },
        { x: 5, y: 0 },
        1,
        {
            excludeId: "self",
            predicate: entity =>
                entity.kind === "person",
        },
    );

    assert.deepEqual(
        results.map(entity => entity.id),
        ["person"],
    );
});


test("local steering is opt-in and default movement remains on the centerline", () => {
    const world = new World();
    const navigation = new Navigation();

    navigation.addNode({ id: "a", x: 0, y: 0 });
    navigation.addNode({ id: "b", x: 100, y: 0 });
    navigation.addRoad({
        id: "road",
        from: "a",
        to: "b",
        width: 6,
    });

    world.addEntity({
        id: "one",
        position: { x: 0, y: 0 },
        mobility: { speed: 1 },
    });
    world.addEntity({
        id: "two",
        position: { x: 0, y: 0 },
    });

    startJourney(world, navigation, "one", "b");
    stepSimulation(world, navigation, 1);

    assert.equal(world.getEntity("one").position.y, 0);
});

test("local steering separates overlapping movers laterally inside road width", () => {
    const world = new World({
        localSteering: {
            neighborRadius: 3,
            separationStrength: 1,
            maxLateralSpeed: 1,
            congestionStrength: 0,
        },
    });
    const navigation = new Navigation();

    navigation.addNode({ id: "a", x: 0, y: 0 });
    navigation.addNode({ id: "b", x: 100, y: 0 });
    navigation.addRoad({
        id: "road",
        from: "a",
        to: "b",
        width: 6,
    });

    for (const id of ["a-walker", "b-walker"]) {
        world.addEntity({
            id,
            position: { x: 0, y: 0 },
            body: { radius: 0.35 },
            mobility: { speed: 1 },
        });

        startJourney(
            world,
            navigation,
            id,
            "b",
        );
    }

    stepSimulation(world, navigation, 1);

    const first = world.getEntity("a-walker").position;
    const second = world.getEntity("b-walker").position;

    assert.notEqual(first.y, second.y);
    assert.ok(Math.abs(first.y) <= 2.6);
    assert.ok(Math.abs(second.y) <= 2.6);
});

test("local steering clamps lateral avoidance to the usable road corridor", () => {
    const world = new World({
        localSteering: {
            neighborRadius: 5,
            separationStrength: 100,
            maxLateralSpeed: 100,
            congestionStrength: 0,
            roadEdgeMargin: 0.05,
        },
    });
    const navigation = new Navigation();

    navigation.addNode({ id: "a", x: 0, y: 0 });
    navigation.addNode({ id: "b", x: 100, y: 0 });
    navigation.addRoad({
        id: "narrow",
        from: "a",
        to: "b",
        width: 1,
    });

    world.addEntity({
        id: "walker",
        position: { x: 0, y: 0 },
        body: { radius: 0.35 },
        mobility: { speed: 1 },
    });
    world.addEntity({
        id: "blocker",
        position: { x: 0, y: 0 },
        body: { radius: 0.35 },
    });

    startJourney(world, navigation, "walker", "b");
    stepSimulation(world, navigation, 1);

    const y = Math.abs(
        world.getEntity("walker").position.y,
    );

    assert.ok(y <= 0.100001);
});

test("local congestion slows movement from measured nearby occupancy", () => {
    function simulate(crowded) {
        const world = new World({
            localSteering: {
                neighborRadius: 4,
                congestionThreshold: 0.5,
                congestionStrength: 2,
                forwardPressureWeight: 1,
                minSpeedMultiplier: 0.1,
                separationStrength: 0,
            },
        });
        const navigation = new Navigation();

        navigation.addNode({
            id: "a",
            x: 0,
            y: 0,
        });
        navigation.addNode({
            id: "b",
            x: 100,
            y: 0,
        });
        navigation.addRoad({
            id: "road",
            from: "a",
            to: "b",
            width: 2,
        });

        world.addEntity({
            id: "walker",
            position: { x: 0, y: 0 },
            body: { radius: 0.35 },
            mobility: { speed: 2 },
        });

        if (crowded) {
            for (let i = 0; i < 5; i++) {
                world.addEntity({
                    id: `crowd-${i}`,
                    position: {
                        x: 0.5 + i * 0.4,
                        y: 0,
                    },
                    body: { radius: 0.35 },
                });
            }
        }

        startJourney(
            world,
            navigation,
            "walker",
            "b",
        );
        stepSimulation(world, navigation, 1);

        return world.getEntity("walker").position.x;
    }

    const solo = simulate(false);
    const crowded = simulate(true);

    assert.ok(crowded < solo);
    assert.equal(solo, 2);
});

test("entities can opt out of world local steering individually", () => {
    const world = new World({
        localSteering: {
            neighborRadius: 3,
            separationStrength: 1,
            congestionStrength: 0,
        },
    });
    const navigation = buildLineNavigation(100);

    world.addEntity({
        id: "walker",
        position: { x: 0, y: 0 },
        mobility: {
            speed: 1,
            localSteering: false,
        },
    });
    world.addEntity({
        id: "blocker",
        position: { x: 0, y: 0 },
    });

    startJourney(world, navigation, "walker", "b");
    stepSimulation(world, navigation, 1);

    assert.equal(
        world.getEntity("walker").position.y,
        0,
    );
});


test("movement event capture is opt-in and drainable without replacing the target array", () => {
    const world = new World();
    const navigation = buildLineNavigation(10);

    world.addEntity({
        id: "walker",
        position: { x: 0, y: 0 },
        mobility: { speed: 1 },
    });

    startJourney(world, navigation, "walker", "b");
    stepSimulation(world, navigation, 10);

    assert.equal(world.peekEvents().length, 0);

    world.setEventCapture(true);

    world.setPosition("walker", { x: 0, y: 0 });
    startJourney(world, navigation, "walker", "b");
    stepSimulation(world, navigation, 10);

    const target = [];
    const drained = world.drainEvents(target);

    assert.strictEqual(drained, target);
    assert.equal(world.peekEvents().length, 0);
    assert.deepEqual(
        drained.map(event => event.type),
        [
            "journeyStarted",
            "roadEntered",
            "roadLeft",
            "journeyCompleted",
        ],
    );
});

test("road lifecycle events are emitted in deterministic traversal order", () => {
    const world = new World({
        captureEvents: true,
    });
    const navigation = new Navigation();

    navigation.addNode({ id: "a", x: 0, y: 0 });
    navigation.addNode({ id: "b", x: 10, y: 0 });
    navigation.addNode({ id: "c", x: 20, y: 0 });

    navigation.addRoad({
        id: "ab",
        from: "a",
        to: "b",
    });
    navigation.addRoad({
        id: "bc",
        from: "b",
        to: "c",
    });

    world.addEntity({
        id: "walker",
        position: { x: 0, y: 0 },
        mobility: { speed: 1 },
    });

    startJourney(world, navigation, "walker", "c");
    stepSimulation(world, navigation, 20);

    const events = world.drainEvents();

    assert.deepEqual(
        events.map(event => [
            event.type,
            event.roadId ?? null,
        ]),
        [
            ["journeyStarted", null],
            ["roadEntered", "ab"],
            ["roadLeft", "ab"],
            ["roadEntered", "bc"],
            ["roadLeft", "bc"],
            ["journeyCompleted", null],
        ],
    );

    assert.equal(events[0].time, 0);
    assert.equal(events.at(-1).time, 20);
});

test("manual rerouting and cancellation emit lifecycle events", () => {
    const world = new World({
        captureEvents: true,
    });
    const navigation = new Navigation();

    navigation.addNode({ id: "a", x: 0, y: 0 });
    navigation.addNode({ id: "b", x: 100, y: 0 });
    navigation.addNode({ id: "c", x: 0, y: 100 });

    navigation.addRoad({
        id: "ab",
        from: "a",
        to: "b",
    });
    navigation.addRoad({
        id: "ac",
        from: "a",
        to: "c",
    });

    world.addEntity({
        id: "walker",
        position: { x: 0, y: 0 },
        mobility: { speed: 1 },
    });

    startJourney(world, navigation, "walker", "b");
    world.drainEvents();

    rerouteJourney(
        world,
        navigation,
        "walker",
        "c",
    );

    const rerouteTypes =
        world.drainEvents()
            .map(event => event.type);

    assert.deepEqual(
        rerouteTypes,
        [
            "journeyRerouted",
            "roadLeft",
            "roadEntered",
        ],
    );

    stopJourney(
        world.getEntity("walker"),
        world,
    );

    assert.deepEqual(
        world.drainEvents()
            .map(event => event.type),
        [
            "roadLeft",
            "journeyCancelled",
        ],
    );
});

test("failed automatic replanning emits journeyFailed with the reason", () => {
    const world = new World({
        captureEvents: true,
    });
    const navigation = buildLineNavigation(100);

    world.addEntity({
        id: "walker",
        position: { x: 0, y: 0 },
        mobility: {
            profileId: "walker",
            speed: 1,
        },
    });

    startJourney(world, navigation, "walker", "b");
    world.drainEvents();

    navigation.setRoadEnabled("road", false);
    stepSimulation(world, navigation, 1);

    const events = world.drainEvents();

    assert.deepEqual(
        events.map(event => event.type),
        ["roadLeft", "journeyFailed"],
    );
    assert.equal(
        events.at(-1).reason,
        "route-invalidated",
    );
});


test("world-core snapshots survive JSON round-trips and preserve dynamic navigation", () => {
    const navigation = new Navigation({
        spatialCellSize: 25,
        routeCacheSize: 17,
        routeCacheMaxLegs: 23,
        routeCacheMaxTotalLegs: 91,
    });

    navigation.addNode({ id: "a", x: 0, y: 0 });
    navigation.addNode({ id: "b", x: 100, y: 0 });
    navigation.addNode({ id: "c", x: 200, y: 0 });

    navigation.addRoad({
        id: "ab",
        from: "a",
        to: "b",
        width: 5,
        surface: "street",
        allowedProfiles: ["pedestrian"],
        tags: ["public"],
        shape: [{ x: 50, y: 10 }],
    });

    navigation.addRoad({
        id: "bc",
        from: "b",
        to: "c",
        width: 4,
        surface: "road",
        bidirectional: false,
    });

    navigation.setRoadWidth("ab", 6);
    navigation.setRoadSurface("ab", "mud");
    navigation.setRoadAccess("ab", {
        allowedProfiles: ["pedestrian", "horse"],
        blockedProfiles: ["cart"],
        tags: ["public", "market"],
    });
    navigation.replaceRoadGeometry("ab", [
        { x: 40, y: 12 },
        { x: 70, y: -4 },
    ]);

    const world = new World({
        spatialCellSize: 12,
        captureEvents: true,
        movementLodTiers: [
            { maxDistance: 50, interval: 0 },
            { maxDistance: Infinity, interval: 10 },
        ],
        interestPoints: [{ x: 0, y: 0 }],
        localSteering: {
            enabled: true,
            neighborRadius: 3,
        },
    });

    world.time = 123.5;

    world.addEntity({
        id: "walker",
        kind: "person",
        position: { x: 0, y: 0 },
        mobility: mobilityProfile("pedestrian"),
    });

    world.addEntity({
        id: "custom",
        position: { x: 10, y: 10 },
        mobility: {
            profileId: "custom",
            speed: 1.1,
            requiredRoadWidth: 1,
        },
    });

    startJourney(
        world,
        navigation,
        "walker",
        "b",
    );

    world.emitEvent("transient", {
        entityId: "walker",
    });

    const encoded = JSON.stringify(
        serializeWorldCore(
            world,
            navigation,
        ),
    );

    const restored = deserializeWorldCore(
        JSON.parse(encoded),
    );

    assert.equal(restored.world.time, 123.5);
    assert.equal(restored.world.spatial.cellSize, 12);
    assert.equal(restored.navigation.nodeIndex.cellSize, 25);
    assert.equal(restored.navigation.routeCacheSize, 17);
    assert.equal(restored.navigation.routeCache.size, 0);
    assert.equal(restored.world.peekEvents().length, 0);
    assert.equal(restored.world.captureEvents, true);

    assert.equal(
        restored.world.movementLodTiers.at(-1).maxDistance,
        Infinity,
    );

    const restoredRoad =
        restored.navigation.roads.get("ab");

    assert.equal(restoredRoad.width, 6);
    assert.equal(restoredRoad.surface, "mud");
    assert.equal(restoredRoad.version, 5);
    assert.deepEqual(
        restoredRoad.allowedProfiles,
        ["horse", "pedestrian"],
    );
    assert.deepEqual(
        restoredRoad.blockedProfiles,
        ["cart"],
    );
    assert.deepEqual(
        restoredRoad.tags,
        ["market", "public"],
    );
    assert.deepEqual(
        restoredRoad.points,
        [
            { x: 0, y: 0 },
            { x: 40, y: 12 },
            { x: 70, y: -4 },
            { x: 100, y: 0 },
        ],
    );

    assert.strictEqual(
        restored.world.getEntity("walker").mobility,
        mobilityProfile("pedestrian"),
    );

    assert.equal(
        restored.world.getEntity("custom").mobility.speed,
        1.1,
    );

    assert.ok(
        restored.world.getEntity("walker").journey,
    );

    restored.world.assertInternalConsistency();
});

test("snapshot restoration preserves shared active routes without restoring route cache", () => {
    const world = new World();
    const navigation = new Navigation();

    navigation.addNode({ id: "a", x: 0, y: 0 });
    navigation.addNode({ id: "b", x: 100, y: 0 });

    navigation.addRoad({
        id: "road",
        from: "a",
        to: "b",
    });

    for (const id of ["one", "two"]) {
        world.addEntity({
            id,
            position: { x: 0, y: 0 },
            mobility: mobilityProfile("pedestrian"),
        });

        startJourney(
            world,
            navigation,
            id,
            "b",
        );
    }

    assert.strictEqual(
        world.getEntity("one").journey.route,
        world.getEntity("two").journey.route,
    );

    const snapshot =
        serializeWorldCore(world, navigation);

    const restored =
        deserializeWorldCore(
            structuredClone(snapshot),
        );

    assert.strictEqual(
        restored.world.getEntity("one").journey.route,
        restored.world.getEntity("two").journey.route,
    );

    assert.equal(
        restored.navigation.routeCache.size,
        0,
    );
});

test("save and restore resumes to the same deterministic end state including LOD accumulator", () => {
    function createSimulation() {
        const navigation = new Navigation();

        navigation.addNode({
            id: "a",
            x: 1000,
            y: 0,
        });
        navigation.addNode({
            id: "b",
            x: 1200,
            y: 0,
        });
        navigation.addRoad({
            id: "road",
            from: "a",
            to: "b",
        });

        const world = new World({
            movementLodTiers: [
                {
                    maxDistance: 100,
                    interval: 0,
                },
                {
                    maxDistance: Infinity,
                    interval: 10,
                },
            ],
            interestPoints: [
                { x: 0, y: 0 },
            ],
        });

        world.addEntity({
            id: "walker",
            position: { x: 1000, y: 0 },
            mobility: {
                profileId: "save-test",
                speed: 1,
            },
        });

        startJourney(
            world,
            navigation,
            "walker",
            "b",
        );

        return { world, navigation };
    }

    const uninterrupted = createSimulation();
    const toRestore = createSimulation();

    for (let i = 0; i < 7; i++) {
        stepSimulation(
            uninterrupted.world,
            uninterrupted.navigation,
            1,
        );
        stepSimulation(
            toRestore.world,
            toRestore.navigation,
            1,
        );
    }

    const interval = 10;

    assert.equal(
        toRestore.world.movementAccumulators.get(interval),
        7,
    );

    const restored = deserializeWorldCore(
        JSON.parse(
            JSON.stringify(
                serializeWorldCore(
                    toRestore.world,
                    toRestore.navigation,
                ),
            ),
        ),
    );

    assert.equal(
        restored.world.movementAccumulators.get(interval),
        7,
    );

    for (let i = 0; i < 23; i++) {
        stepSimulation(
            uninterrupted.world,
            uninterrupted.navigation,
            1,
        );
        stepSimulation(
            restored.world,
            restored.navigation,
            1,
        );
    }

    assert.deepEqual(
        serializeWorldCore(
            restored.world,
            restored.navigation,
        ),
        serializeWorldCore(
            uninterrupted.world,
            uninterrupted.navigation,
        ),
    );
});

test("unsupported snapshot versions are rejected", () => {
    assert.throws(
        () =>
            deserializeWorldCore({
                format: "world-core",
                version: 999,
            }),
        /Invalid world-core snapshot at \$\.version/,
    );
});


test("package self-reference exposes only the intended public API", async () => {
    const api = await import("world-core");

    assert.deepEqual(
        Object.keys(api).sort(),
        [
            "MOBILITY_PROFILES",
            "Navigation",
            "WORLD_CORE_SNAPSHOT_VERSION",
            "World",
            "computeWorldCoreStateHash",
            "computeWorldCoreStateHashes",
            "deserializeWorldCore",
            "mobilityProfile",
            "rerouteJourney",
            "serializeWorldCore",
            "startJourney",
            "stepSimulation",
            "stopJourney",
            "validateWorldCoreSnapshot",
        ].sort(),
    );

    assert.equal("SpatialHash" in api, false);
    assert.equal("StaticSpatialIndex" in api, false);
    assert.equal("MinPriorityQueue" in api, false);
});


test("navigation consistency diagnostics survive dynamic graph mutations and cached routes", () => {
    const navigation = new Navigation({
        spatialCellSize: 10,
        routeCacheSize: 100,
        routeCacheMaxTotalLegs: 1000,
    });
    const mobility = {
        profileId: "walker",
        speed: 1,
    };

    navigation.addNode({ id: "a", x: 0, y: 0 });
    navigation.addNode({ id: "b", x: 10, y: 0 });
    navigation.addNode({ id: "c", x: 20, y: 0 });
    navigation.addNode({ id: "d", x: 10, y: 10 });

    navigation.addRoad({
        id: "ab",
        from: "a",
        to: "b",
    });
    navigation.addRoad({
        id: "bc",
        from: "b",
        to: "c",
    });
    navigation.addRoad({
        id: "bd",
        from: "b",
        to: "d",
        bidirectional: false,
    });

    navigation.findRoute("a", "c", mobility);
    navigation.findRoute("c", "a", mobility);

    let diagnostics =
        navigation.assertInternalConsistency();

    assert.equal(diagnostics.nodeCount, 4);
    assert.equal(diagnostics.roadCount, 3);
    assert.equal(diagnostics.adjacencyEdgeCount, 5);
    assert.equal(diagnostics.componentCount, 1);

    navigation.setRoadEnabled("bc", false);
    navigation.setRoadWidth("ab", 6);
    navigation.setRoadSurface("ab", "mud");
    navigation.replaceRoadGeometry("ab", [
        { x: 5, y: 2 },
    ]);
    navigation.setRoadBidirectional("bd", true);

    diagnostics =
        navigation.assertInternalConsistency();

    assert.equal(diagnostics.nodeCount, 4);
    assert.equal(diagnostics.roadCount, 3);
    assert.equal(diagnostics.adjacencyEdgeCount, 6);

    navigation.removeRoad("bc");
    navigation.removeNode("d");

    diagnostics =
        navigation.assertInternalConsistency();

    assert.equal(diagnostics.nodeCount, 3);
    assert.equal(diagnostics.roadCount, 1);
    assert.equal(diagnostics.componentCount, 2);
});

test("navigation consistency diagnostics detect adjacency corruption", () => {
    const navigation = buildLineNavigation(100);

    navigation.adjacency.get("a").push({
        roadId: "road",
        to: "b",
        reversed: false,
    });

    assert.throws(
        () =>
            navigation.assertInternalConsistency(),
        /Road forward adjacency mismatch|Adjacency edge count drift|Duplicate adjacency edge/,
    );
});

test("navigation consistency diagnostics detect stale spatial index entries", () => {
    const navigation = buildLineNavigation(100);

    navigation.roadIndex.itemCells.set(
        "ghost-road",
        123,
    );

    assert.throws(
        () =>
            navigation.assertInternalConsistency(),
        /Road index drift|stale road/,
    );
});

test("navigation consistency diagnostics detect stale route cache versions", () => {
    const navigation = buildLineNavigation(100);
    const mobility = {
        profileId: "walker",
        speed: 1,
    };

    const route =
        navigation.findRoute(
            "a",
            "b",
            mobility,
        );

    assert.ok(route);
    navigation.roads.get("road").version++;

    assert.throws(
        () =>
            navigation.assertInternalConsistency(),
        /stale road version/,
    );
});


test("counterflow steering puts opposing movers on opposite physical sides", () => {
    const world = new World({
        localSteering: {
            neighborRadius: 8,
            counterflowStrength: 1.2,
            separationStrength: 1,
            maxLateralSpeed: 1.5,
            centeringRate: 0.2,
            congestionStrength: 0,
            trafficSide: "right",
        },
    });
    const navigation = buildLineNavigation(100);

    world.addEntity({
        id: "eastbound",
        position: { x: 48, y: 0 },
        mobility: { speed: 1 },
    });
    world.addEntity({
        id: "westbound",
        position: { x: 52, y: 0 },
        mobility: { speed: 1 },
    });

    startJourney(
        world,
        navigation,
        "eastbound",
        "b",
    );
    startJourney(
        world,
        navigation,
        "westbound",
        "a",
    );

    for (let i = 0; i < 3; i++) {
        stepSimulation(
            world,
            navigation,
            0.5,
        );
    }

    const east =
        world.getEntity("eastbound");
    const west =
        world.getEntity("westbound");

    assert.ok(east.position.y < 0);
    assert.ok(west.position.y > 0);
    assert.ok(
        Math.abs(east.position.y) <= 1.61,
    );
    assert.ok(
        Math.abs(west.position.y) <= 1.61,
    );
});

test("same-direction steering does not ping-pong its lateral side while resolving overlap", () => {
    const world = new World({
        localSteering: {
            neighborRadius: 4,
            separationStrength: 1.2,
            maxLateralSpeed: 1,
            centeringRate: 0.15,
            congestionStrength: 0,
        },
    });
    const navigation = buildLineNavigation(100);

    world.addEntity({
        id: "a-walker",
        position: { x: 20, y: 0 },
        mobility: { speed: 1 },
    });
    world.addEntity({
        id: "b-walker",
        position: { x: 20.05, y: 0 },
        mobility: { speed: 1 },
    });

    startJourney(
        world,
        navigation,
        "a-walker",
        "b",
    );
    startJourney(
        world,
        navigation,
        "b-walker",
        "b",
    );

    const signs = [];

    for (let i = 0; i < 12; i++) {
        stepSimulation(
            world,
            navigation,
            0.25,
        );

        const y =
            world.getEntity(
                "a-walker",
            ).position.y;

        if (Math.abs(y) > 0.01) {
            signs.push(Math.sign(y));
        }
    }

    assert.ok(signs.length > 2);
    assert.equal(
        new Set(signs).size,
        1,
    );
});

test("steering handles mixed body sizes on a narrow road without leaving the corridor", () => {
    const world = new World({
        localSteering: {
            neighborRadius: 5,
            separationStrength: 2,
            maxLateralSpeed: 4,
            centeringRate: 0.1,
            congestionStrength: 0,
        },
    });
    const navigation = new Navigation();

    navigation.addNode({
        id: "a",
        x: 0,
        y: 0,
    });
    navigation.addNode({
        id: "b",
        x: 100,
        y: 0,
    });
    navigation.addRoad({
        id: "road",
        from: "a",
        to: "b",
        width: 2,
    });

    world.addEntity({
        id: "large",
        position: { x: 20, y: 0 },
        body: { radius: 0.8 },
        mobility: { speed: 1 },
    });
    world.addEntity({
        id: "small",
        position: { x: 20.1, y: 0 },
        body: { radius: 0.2 },
        mobility: { speed: 1 },
    });

    startJourney(
        world,
        navigation,
        "large",
        "b",
    );
    startJourney(
        world,
        navigation,
        "small",
        "b",
    );

    for (let i = 0; i < 10; i++) {
        stepSimulation(
            world,
            navigation,
            0.25,
        );
    }

    assert.ok(
        Math.abs(
            world.getEntity("large")
                .position.y,
        ) <= 0.150001,
    );
    assert.ok(
        Math.abs(
            world.getEntity("small")
                .position.y,
        ) <= 0.750001,
    );
});

test("steering remains finite and corridor-bounded for a dense node launch", () => {
    const world = new World({
        localSteering: {
            neighborRadius: 3,
            separationStrength: 1,
            maxLateralSpeed: 1.5,
            centeringRate: 0.2,
            congestionStrength: 0.5,
            minSpeedMultiplier: 0.1,
        },
    });
    const navigation = new Navigation();

    navigation.addNode({
        id: "a",
        x: 0,
        y: 0,
    });
    navigation.addNode({
        id: "b",
        x: 200,
        y: 0,
    });
    navigation.addRoad({
        id: "road",
        from: "a",
        to: "b",
        width: 8,
    });

    for (let i = 0; i < 40; i++) {
        const id = `walker-${String(i).padStart(2, "0")}`;

        world.addEntity({
            id,
            position: { x: 0, y: 0 },
            body: {
                radius:
                    0.25 +
                    (i % 4) * 0.05,
            },
            mobility: {
                speed:
                    1 +
                    (i % 3) * 0.1,
            },
        });

        startJourney(
            world,
            navigation,
            id,
            "b",
        );
    }

    for (let tick = 0; tick < 30; tick++) {
        stepSimulation(
            world,
            navigation,
            0.2,
        );
    }

    for (const entity of world.entities.values()) {
        assert.ok(
            Number.isFinite(entity.position.x),
        );
        assert.ok(
            Number.isFinite(entity.position.y),
        );

        const usable =
            4 -
            (entity.body?.radius ?? 0) -
            world.localSteering.roadEdgeMargin;

        assert.ok(
            Math.abs(entity.position.y) <=
                usable + 1e-6,
        );
    }

    world.assertInternalConsistency();
    navigation.assertInternalConsistency();
});

test("a stationary blocker produces a stable avoidance side", () => {
    const world = new World({
        localSteering: {
            neighborRadius: 4,
            separationStrength: 1,
            maxLateralSpeed: 1,
            centeringRate: 0.1,
            congestionStrength: 0,
        },
    });
    const navigation = buildLineNavigation(100);

    world.addEntity({
        id: "walker",
        position: { x: 20, y: 0 },
        mobility: { speed: 1 },
    });
    world.addEntity({
        id: "blocker",
        position: { x: 20.4, y: 0 },
        body: { radius: 0.5 },
    });

    startJourney(
        world,
        navigation,
        "walker",
        "b",
    );

    const signs = [];

    for (let i = 0; i < 8; i++) {
        stepSimulation(
            world,
            navigation,
            0.25,
        );

        const y =
            world.getEntity(
                "walker",
            ).position.y;

        if (Math.abs(y) > 0.01) {
            signs.push(Math.sign(y));
        }
    }

    assert.ok(signs.length > 0);
    assert.equal(
        new Set(signs).size,
        1,
    );
});


test("junction radius allows road transitions without forcing the exact node center", () => {
    const world = new World();
    const navigation = new Navigation();

    navigation.addNode({
        id: "west",
        x: 0,
        y: 0,
    });
    navigation.addNode({
        id: "junction",
        x: 10,
        y: 0,
        junctionRadius: 2,
    });
    navigation.addNode({
        id: "north",
        x: 10,
        y: 10,
    });

    navigation.addRoad({
        id: "west-road",
        from: "west",
        to: "junction",
    });
    navigation.addRoad({
        id: "north-road",
        from: "junction",
        to: "north",
    });

    world.addEntity({
        id: "walker",
        position: { x: 0, y: 0 },
        mobility: { speed: 1 },
    });

    startJourney(
        world,
        navigation,
        "walker",
        "north",
    );

    for (let i = 0; i < 8; i++) {
        stepSimulation(
            world,
            navigation,
            1,
        );
    }

    assert.equal(
        world.getEntity("walker").position.x,
        8,
    );
    assert.equal(
        world.getEntity("walker").journey.legIndex,
        0,
    );

    stepSimulation(
        world,
        navigation,
        0.001,
    );

    const walker =
        world.getEntity("walker");

    assert.equal(
        walker.journey.legIndex,
        1,
    );

    assert.notDeepEqual(
        walker.position,
        { x: 10, y: 0 },
    );

    const junctionDistance =
        Math.hypot(
            walker.position.x - 10,
            walker.position.y,
        );

    assert.ok(
        junctionDistance <= 2.001,
    );
});

test("junction radius can be changed dynamically and is covered by navigation invariants", () => {
    const navigation = new Navigation();

    navigation.addNode({
        id: "node",
        x: 0,
        y: 0,
    });

    assert.equal(
        navigation.nodes.get("node").junctionRadius,
        0,
    );

    assert.equal(
        navigation.setNodeJunctionRadius(
            "node",
            3,
        ),
        true,
    );

    assert.equal(
        navigation.nodes.get("node").junctionRadius,
        3,
    );

    navigation.assertInternalConsistency();

    assert.throws(
        () =>
            navigation.setNodeJunctionRadius(
                "node",
                -1,
            ),
        /junctionRadius/,
    );
});

test("world obstacles support circle AABB and segment queries with enable and replacement", () => {
    const world = new World({
        obstacleCellSize: 5,
    });

    world.addObstacle({
        id: "well",
        type: "circle",
        center: { x: 10, y: 0 },
        radius: 2,
    });

    world.addObstacle({
        id: "stall",
        type: "aabb",
        minX: 20,
        minY: -2,
        maxX: 24,
        maxY: 2,
    });

    world.addObstacle({
        id: "wall",
        type: "segment",
        a: { x: 30, y: -5 },
        b: { x: 30, y: 5 },
        radius: 0.5,
        temporary: true,
    });

    assert.deepEqual(
        world.queryObstaclesRadiusInto(
            { x: 8, y: 0 },
            0.1,
        ).map(obstacle => obstacle.id),
        ["well"],
    );

    assert.deepEqual(
        world.queryObstaclesRadiusInto(
            { x: 22, y: 0 },
            0,
        ).map(obstacle => obstacle.id),
        ["stall"],
    );

    assert.deepEqual(
        world.queryObstaclesRadiusInto(
            { x: 29.6, y: 0 },
            0,
        ).map(obstacle => obstacle.id),
        ["wall"],
    );

    world.setObstacleEnabled(
        "wall",
        false,
    );

    assert.deepEqual(
        world.queryObstaclesRadiusInto(
            { x: 30, y: 0 },
            1,
        ).map(obstacle => obstacle.id),
        [],
    );

    world.replaceObstacle(
        "stall",
        {
            minX: 40,
            maxX: 44,
        },
    );

    assert.equal(
        world.queryObstaclesRadiusInto(
            { x: 22, y: 0 },
            1,
        ).length,
        0,
    );

    assert.deepEqual(
        world.queryObstaclesRadiusInto(
            { x: 42, y: 0 },
            0,
        ).map(obstacle => obstacle.id),
        ["stall"],
    );

    world.assertInternalConsistency();
});

test("local steering avoids a static obstacle inside the road corridor", () => {
    const world = new World({
        localSteering: {
            neighborRadius: 3,
            obstacleLookahead: 5,
            obstacleMargin: 0.3,
            obstacleStrength: 2,
            maxLateralSpeed: 2,
            centeringRate: 0.1,
            congestionStrength: 0,
            trafficSide: "right",
        },
    });
    const navigation = buildLineNavigation(100);

    world.addObstacle({
        id: "market-stand",
        type: "circle",
        center: { x: 6, y: 0 },
        radius: 0.6,
    });

    world.addEntity({
        id: "walker",
        position: { x: 0, y: 0 },
        body: { radius: 0.35 },
        mobility: { speed: 1.5 },
    });

    startJourney(
        world,
        navigation,
        "walker",
        "b",
    );

    let minimumCenterDistance =
        Infinity;

    for (let i = 0; i < 40; i++) {
        stepSimulation(
            world,
            navigation,
            0.1,
        );

        const position =
            world.getEntity(
                "walker",
            ).position;

        minimumCenterDistance =
            Math.min(
                minimumCenterDistance,
                Math.hypot(
                    position.x - 6,
                    position.y,
                ),
            );
    }

    const walker =
        world.getEntity("walker");

    assert.ok(
        walker.position.y < -0.05,
    );

    assert.ok(
        minimumCenterDistance >
        0.6,
    );
});

test("temporary road effects can block or penalize routing without deleting roads", () => {
    const navigation = new Navigation();
    const mobility = {
        profileId: "walker",
        speed: 1,
    };

    navigation.addNode({
        id: "a",
        x: 0,
        y: 0,
    });
    navigation.addNode({
        id: "b",
        x: 10,
        y: 0,
    });
    navigation.addNode({
        id: "c",
        x: 20,
        y: 0,
    });
    navigation.addNode({
        id: "d",
        x: 10,
        y: 8,
    });

    navigation.addRoad({
        id: "ab",
        from: "a",
        to: "b",
    });
    navigation.addRoad({
        id: "bc",
        from: "b",
        to: "c",
    });
    navigation.addRoad({
        id: "ad",
        from: "a",
        to: "d",
    });
    navigation.addRoad({
        id: "dc",
        from: "d",
        to: "c",
    });

    assert.deepEqual(
        navigation.findRoute(
            "a",
            "c",
            mobility,
        ).legs.map(leg => leg.roadId),
        ["ab", "bc"],
    );

    navigation.setRoadEffect(
        "market-crowd",
        "ab",
        {
            costMultiplier: 5,
        },
    );

    assert.deepEqual(
        navigation.findRoute(
            "a",
            "c",
            mobility,
        ).legs.map(leg => leg.roadId),
        ["ad", "dc"],
    );

    navigation.setRoadEffect(
        "closed-gate",
        "dc",
        {
            blocked: true,
        },
    );

    assert.deepEqual(
        navigation.findRoute(
            "a",
            "c",
            mobility,
        ).legs.map(leg => leg.roadId),
        ["ab", "bc"],
    );

    assert.equal(
        navigation.roads.has("dc"),
        true,
    );

    navigation.removeRoadEffect(
        "market-crowd",
        "ab",
    );
    navigation.clearRoadEffect(
        "closed-gate",
    );

    assert.deepEqual(
        navigation.findRoute(
            "a",
            "c",
            mobility,
        ).legs.map(leg => leg.roadId),
        ["ab", "bc"],
    );

    navigation.assertInternalConsistency();
});

test("active journeys replan when a transient road effect changes route cost", () => {
    const world = new World();
    const navigation = new Navigation();

    navigation.addNode({
        id: "a",
        x: 0,
        y: 0,
    });
    navigation.addNode({
        id: "b",
        x: 10,
        y: 0,
    });
    navigation.addNode({
        id: "c",
        x: 20,
        y: 0,
    });
    navigation.addNode({
        id: "d",
        x: 10,
        y: 10,
    });

    navigation.addRoad({
        id: "ab",
        from: "a",
        to: "b",
    });
    navigation.addRoad({
        id: "bc",
        from: "b",
        to: "c",
    });
    navigation.addRoad({
        id: "ad",
        from: "a",
        to: "d",
    });
    navigation.addRoad({
        id: "dc",
        from: "d",
        to: "c",
    });

    world.addEntity({
        id: "walker",
        position: { x: 0, y: 0 },
        mobility: {
            profileId: "walker",
            speed: 1,
        },
    });

    startJourney(
        world,
        navigation,
        "walker",
        "c",
    );

    navigation.setRoadEffect(
        "parade",
        "bc",
        {
            blocked: true,
        },
    );

    stepSimulation(
        world,
        navigation,
        0.1,
    );

    assert.deepEqual(
        world.getEntity("walker")
            .journey.route.legs
            .map(leg => leg.roadId),
        ["ad", "dc"],
    );
});

test("snapshot round-trip preserves junction radii obstacles and transient road effects", () => {
    const world = new World({
        obstacleCellSize: 7,
    });
    const navigation = new Navigation();

    navigation.addNode({
        id: "a",
        x: 0,
        y: 0,
        junctionRadius: 1.5,
    });
    navigation.addNode({
        id: "b",
        x: 10,
        y: 0,
    });

    navigation.addRoad({
        id: "road",
        from: "a",
        to: "b",
    });

    navigation.setRoadEffect(
        "construction",
        "road",
        {
            costMultiplier: 3,
        },
    );

    world.addObstacle({
        id: "barrier",
        type: "segment",
        a: { x: 5, y: -1 },
        b: { x: 5, y: 1 },
        radius: 0.2,
        temporary: true,
        tags: ["construction"],
    });

    const restored =
        deserializeWorldCore(
            JSON.parse(
                JSON.stringify(
                    serializeWorldCore(
                        world,
                        navigation,
                    ),
                ),
            ),
        );

    assert.equal(
        restored.navigation.nodes
            .get("a")
            .junctionRadius,
        1.5,
    );

    assert.equal(
        restored.navigation
            .roadCostMultiplier("road"),
        3,
    );

    assert.equal(
        restored.world.obstacles
            .index.cellSize,
        7,
    );

    const obstacle =
        restored.world.obstacles
            .obstacles.get("barrier");

    assert.equal(
        obstacle.temporary,
        true,
    );
    assert.deepEqual(
        obstacle.tags,
        ["construction"],
    );

    restored.world
        .assertInternalConsistency();
    restored.navigation
        .assertInternalConsistency();
});


test("local steering is independent of spatial bucket insertion order", () => {
    function build() {
        const navigation =
            new Navigation({
                spatialCellSize: 10,
            });

        navigation.addNode({
            id: "west",
            x: 0,
            y: 0,
        });
        navigation.addNode({
            id: "east",
            x: 100,
            y: 0,
        });
        navigation.addRoad({
            id: "road",
            from: "west",
            to: "east",
            width: 6,
        });

        const world =
            new World({
                spatialCellSize: 10,
                localSteering: {
                    neighborRadius: 4,
                    separationStrength: 0.9,
                    maxLateralSpeed: 1,
                    centeringRate: 0.2,
                    congestionStrength: 0.5,
                    trafficSide: "right",
                },
            });

        for (let i = 0; i < 12; i++) {
            const id =
                `walker-${String(i).padStart(2, "0")}`;

            world.addEntity({
                id,
                position: {
                    x: 20 + i * 0.15,
                    y: 0,
                },
                body: {
                    radius:
                        0.3 +
                        (i % 3) * 0.03,
                },
                mobility: {
                    profileId:
                        "bucket-order-test",
                    speed:
                        1 +
                        (i % 4) * 0.05,
                },
            });

            startJourney(
                world,
                navigation,
                id,
                "east",
            );
        }

        return {
            world,
            navigation,
        };
    }

    const left = build();
    const right = build();

    assert.equal(
        computeWorldCoreStateHash(
            left.world,
            left.navigation,
        ),
        computeWorldCoreStateHash(
            right.world,
            right.navigation,
        ),
    );

    let reversedSetCount = 0;

    for (
        const [key, cell] of
        right.world.spatial.cells
    ) {
        if (
            !(cell instanceof Set) ||
            cell.size < 2
        ) {
            continue;
        }

        right.world.spatial.cells.set(
            key,
            new Set(
                [...cell].reverse(),
            ),
        );
        reversedSetCount++;
    }

    assert.ok(reversedSetCount > 0);

    for (let tick = 0; tick < 200; tick++) {
        stepSimulation(
            left.world,
            left.navigation,
            0.05,
        );
        stepSimulation(
            right.world,
            right.navigation,
            0.05,
        );

        if (tick % 20 === 0) {
            assert.equal(
                computeWorldCoreStateHash(
                    left.world,
                    left.navigation,
                ),
                computeWorldCoreStateHash(
                    right.world,
                    right.navigation,
                ),
            );
        }
    }

    assert.equal(
        computeWorldCoreStateHash(
            left.world,
            left.navigation,
        ),
        computeWorldCoreStateHash(
            right.world,
            right.navigation,
        ),
    );
});
