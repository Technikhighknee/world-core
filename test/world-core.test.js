import assert from "node:assert/strict";
import test from "node:test";

import { mobilityProfile } from "../src/world/mobility-profiles.js";
import { Navigation } from "../src/world/navigation.js";
import { startJourney, stopJourney } from "../src/world/movement.js";
import { stepSimulation } from "../src/world/simulation.js";
import { SpatialHash } from "../src/world/spatial-hash.js";
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

    const changedWithinCell = spatial.upsert("person", { x: 2, y: 2 }, 0.35);
    assert.equal(changedWithinCell, false);

    const changedAcrossCell = spatial.upsert("person", { x: 21, y: 2 }, 0.35);
    assert.equal(changedAcrossCell, true);
    assert.equal(spatial.queryRadius({ x: 1, y: 1 }, 1).has("person"), false);
    assert.equal(spatial.queryRadius({ x: 21, y: 2 }, 1).has("person"), true);
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
    const originalSetPositionXY = world.setPositionXY.bind(world);

    world.setPositionXY = (...args) => {
        commits++;
        return originalSetPositionXY(...args);
    };

    startJourney(world, navigation, "walker", "b");
    stepSimulation(world, navigation, 1);

    assert.equal(commits, 1);
    assert.equal(world.getEntity("walker").journey, null);
    assert.deepEqual(world.getEntity("walker").position, { x: 100, y: 0 });
});

test("navigation uses indexed node and road lookups", () => {
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
    assert.equal(navigation.nearestNode({ x: 90, y: 0 })?.node.id, "b");
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

test("built-in mobility profiles expose stable cache identities", () => {
    const pedestrian = mobilityProfile("pedestrian");
    const cloned = structuredClone(pedestrian);

    assert.equal(pedestrian.profileId, "pedestrian");
    assert.equal(cloned.profileId, "pedestrian");
    assert.equal(pedestrian.speed, cloned.speed);
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

    const nearby = world.queryRadius(
        { x: 0, y: 0 },
        5,
        { excludeId: "thief" },
    );

    assert.deepEqual(nearby.map(entity => entity.id), ["target"]);
});
