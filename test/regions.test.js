import assert from "node:assert/strict";
import test from "node:test";

import {
    deserializeWorldCore,
    mobilityProfile,
    Navigation,
    serializeWorldCore,
    startJourney,
    stepSimulation,
    World,
    WORLD_CORE_SNAPSHOT_VERSION,
} from "../src/index.js";

function buildRegionalNavigation() {
    const navigation = new Navigation({
        hierarchicalRouteCacheSize: 50,
        regionalRouteCacheSize: 100,
    });

    for (const id of ["west", "middle", "east"]) {
        navigation.addRegion({ id });
    }

    navigation.addNode({
        id: "w0",
        x: 0,
        y: 0,
        regionId: "west",
    });
    navigation.addNode({
        id: "wg",
        x: 10,
        y: 0,
        regionId: "west",
    });
    navigation.addNode({
        id: "m0",
        x: 15,
        y: 0,
        regionId: "middle",
    });
    navigation.addNode({
        id: "m1",
        x: 25,
        y: 0,
        regionId: "middle",
    });
    navigation.addNode({
        id: "eg",
        x: 30,
        y: 0,
        regionId: "east",
    });
    navigation.addNode({
        id: "e0",
        x: 40,
        y: 0,
        regionId: "east",
    });

    navigation.addRoad({
        id: "west-local",
        from: "w0",
        to: "wg",
    });
    navigation.addRoad({
        id: "west-middle",
        from: "wg",
        to: "m0",
    });
    navigation.addRoad({
        id: "middle-local",
        from: "m0",
        to: "m1",
    });
    navigation.addRoad({
        id: "middle-east",
        from: "m1",
        to: "eg",
    });
    navigation.addRoad({
        id: "east-local",
        from: "eg",
        to: "e0",
    });

    navigation.addRoad({
        id: "direct-slow",
        from: "wg",
        to: "eg",
        shape: [
            { x: 10, y: 50 },
            { x: 30, y: 50 },
        ],
    });

    return navigation;
}

test("hierarchical routing refines exact regional gateway routes", () => {
    const navigation =
        buildRegionalNavigation();
    const mobility =
        mobilityProfile("pedestrian");

    const exact =
        navigation.findRoute(
            "w0",
            "e0",
            mobility,
        );
    const hierarchical =
        navigation.findHierarchicalRoute(
            "w0",
            "e0",
            mobility,
        );

    assert.ok(exact);
    assert.ok(hierarchical);

    assert.deepEqual(
        hierarchical.legs.map(
            leg => leg.roadId,
        ),
        exact.legs.map(
            leg => leg.roadId,
        ),
    );

    assert.equal(
        hierarchical.estimatedSeconds,
        exact.estimatedSeconds,
    );

    assert.deepEqual(
        navigation
            .getRegionGateways("middle")
            .map(node => node.id),
        ["m0", "m1"],
    );

    const diagnostics =
        navigation.assertInternalConsistency();

    assert.equal(
        diagnostics.regionCount,
        3,
    );
    assert.equal(
        diagnostics.regionAssignedNodes,
        6,
    );
    assert.equal(
        diagnostics.regionGatewayCount,
        4,
    );
    assert.ok(
        diagnostics.hierarchicalRouteCacheSize >
        0,
    );
});

test("hierarchical route cache invalidates on road effects and topology changes", () => {
    const navigation =
        buildRegionalNavigation();
    const mobility =
        mobilityProfile("pedestrian");

    const first =
        navigation.findHierarchicalRoute(
            "w0",
            "e0",
            mobility,
        );

    assert.ok(first);
    assert.equal(
        navigation.hierarchicalRouteCache.size,
        1,
    );

    navigation.setRoadEffect(
        "closure",
        "middle-east",
        { blocked: true },
    );

    assert.equal(
        navigation.hierarchicalRouteCache.size,
        0,
    );

    const rerouted =
        navigation.findHierarchicalRoute(
            "w0",
            "e0",
            mobility,
        );

    assert.ok(rerouted);
    assert.deepEqual(
        rerouted.legs.map(
            leg => leg.roadId,
        ),
        [
            "west-local",
            "direct-slow",
            "east-local",
        ],
    );

    navigation.clearRoadEffect(
        "closure",
    );

    navigation.setNodeRegion(
        "m1",
        "east",
    );

    navigation.assertInternalConsistency();

    assert.equal(
        navigation.regions
            .get("middle")
            .nodeIds.has("m1"),
        false,
    );
    assert.equal(
        navigation.regions
            .get("east")
            .nodeIds.has("m1"),
        true,
    );
});

test("navigation regions reject invalid membership and non-empty removal", () => {
    const navigation =
        new Navigation();

    navigation.addRegion({
        id: "city",
    });

    navigation.addNode({
        id: "node",
        x: 0,
        y: 0,
        regionId: "city",
    });

    assert.throws(
        () =>
            navigation.removeRegion(
                "city",
            ),
        /non-empty/,
    );

    assert.throws(
        () =>
            navigation.setNodeRegion(
                "node",
                "missing",
            ),
        /Unknown navigation region/,
    );

    navigation.setNodeRegion(
        "node",
        null,
    );

    assert.equal(
        navigation.removeRegion(
            "city",
        ),
        true,
    );

    navigation.assertInternalConsistency();
});

test("snapshot v1 preserves navigation hierarchy", () => {
    const navigation =
        buildRegionalNavigation();
    const world =
        new World();

    const snapshot =
        JSON.parse(
            JSON.stringify(
                serializeWorldCore(
                    world,
                    navigation,
                ),
            ),
        );

    assert.equal(
        snapshot.version,
        1,
    );
    assert.equal(
        WORLD_CORE_SNAPSHOT_VERSION,
        1,
    );

    const restored =
        deserializeWorldCore(
            snapshot,
        );

    assert.deepEqual(
        [...restored.navigation.regions.keys()],
        ["east", "middle", "west"],
    );

    assert.equal(
        restored.navigation.nodes
            .get("w0").regionId,
        "west",
    );

    const exact =
        restored.navigation.findRoute(
            "w0",
            "e0",
            mobilityProfile(
                "pedestrian",
            ),
        );
    const hierarchical =
        restored.navigation
            .findHierarchicalRoute(
                "w0",
                "e0",
                mobilityProfile(
                    "pedestrian",
                ),
            );

    assert.deepEqual(
        hierarchical.legs.map(
            leg => leg.roadId,
        ),
        exact.legs.map(
            leg => leg.roadId,
        ),
    );

    restored.world
        .assertInternalConsistency();
    restored.navigation
        .assertInternalConsistency();
});
