import assert from "node:assert/strict";
import test from "node:test";

import {
    deserializeWorldCore,
    mobilityProfile,
    Navigation,
    serializeWorldCore,
    startJourney,
    validateWorldCoreSnapshot,
    World,
} from "../src/index.js";

function buildNavigation() {
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

    return navigation;
}

function buildJourneySnapshot() {
    const navigation =
        buildNavigation();
    const world = new World();

    world.addEntity({
        id: "walker",
        position: {
            x: 0,
            y: 0,
        },
        body: {
            radius: 0.35,
        },
        mobility:
            mobilityProfile(
                "pedestrian",
            ),
    });

    assert.equal(
        startJourney(
            world,
            navigation,
            "walker",
            "c",
        ),
        true,
    );

    return serializeWorldCore(
        world,
        navigation,
    );
}

function buildPrefixSnapshot() {
    const navigation =
        buildNavigation();
    const world = new World();

    world.addEntity({
        id: "walker",
        position: {
            x: 5,
            y: 0,
        },
        mobility:
            mobilityProfile(
                "pedestrian",
            ),
    });

    assert.equal(
        startJourney(
            world,
            navigation,
            "walker",
            "c",
        ),
        true,
    );

    const snapshot =
        serializeWorldCore(
            world,
            navigation,
        );

    assert.ok(
        snapshot.entities[0]
            .journey.prefixLeg,
    );

    return snapshot;
}

function buildEntryOnlySnapshot() {
    const navigation =
        buildNavigation();
    const world = new World();

    world.addEntity({
        id: "walker",
        position: {
            x: 10,
            y: 5,
        },
        mobility:
            mobilityProfile(
                "pedestrian",
            ),
    });

    assert.equal(
        startJourney(
            world,
            navigation,
            "walker",
            "b",
            {
                entryMaxDistance: 10,
            },
        ),
        true,
    );

    const snapshot =
        serializeWorldCore(
            world,
            navigation,
        );

    assert.equal(
        snapshot.routes[
            snapshot.entities[0]
                .journey.routeId
        ].legs.length,
        0,
    );
    assert.ok(
        snapshot.entities[0]
            .journey.entryPoint,
    );

    return snapshot;
}

function buildLodSnapshot() {
    const navigation =
        buildNavigation();
    const world = new World({
        movementLodTiers: [
            {
                maxDistance:
                    Infinity,
                interval: 10,
            },
        ],
        interestPoints: [
            {
                x: 0,
                y: 0,
            },
        ],
    });

    world.addEntity({
        id: "walker",
        position: {
            x: 0,
            y: 0,
        },
        mobility:
            mobilityProfile(
                "pedestrian",
            ),
    });

    startJourney(
        world,
        navigation,
        "walker",
        "c",
    );

    return serializeWorldCore(
        world,
        navigation,
    );
}

test("current snapshot validation accepts canonical journey, prefix, and entry-only states", () => {
    for (
        const snapshot of
        [
            buildJourneySnapshot(),
            buildPrefixSnapshot(),
            buildEntryOnlySnapshot(),
        ]
    ) {
        assert.equal(
            validateWorldCoreSnapshot(
                snapshot,
            ),
            true,
        );

        const restored =
            deserializeWorldCore(
                structuredClone(
                    snapshot,
                ),
            );

        restored.world
            .assertInternalConsistency();
        restored.navigation
            .assertInternalConsistency();
    }
});

test("profile mobility encoding rejects unknown built-ins while inline custom mobility remains valid", () => {
    const badProfile =
        buildJourneySnapshot();

    badProfile.entities[0]
        .mobility.profileId =
        "missing-profile";

    assert.throws(
        () =>
            validateWorldCoreSnapshot(
                badProfile,
            ),
        /unknown mobility profile/,
    );

    const navigation =
        buildNavigation();
    const world =
        new World();

    world.addEntity({
        id: "custom",
        position: {
            x: 0,
            y: 0,
        },
        mobility: {
            profileId:
                "custom-profile",
            speed: 1,
        },
    });

    startJourney(
        world,
        navigation,
        "custom",
        "c",
    );

    const customSnapshot =
        serializeWorldCore(
            world,
            navigation,
        );

    assert.equal(
        customSnapshot.entities[0]
            .mobility.type,
        "inline",
    );
    assert.equal(
        validateWorldCoreSnapshot(
            customSnapshot,
        ),
        true,
    );
});

test("journey destination must match its serialized route destination", () => {
    const snapshot =
        buildJourneySnapshot();

    snapshot.entities[0]
        .journey.destinationNodeId =
        "b";

    assert.throws(
        () =>
            validateWorldCoreSnapshot(
                snapshot,
            ),
        /does not match route destination/,
    );
});

test("active journey indices must describe a reachable current movement state", () => {
    const exhausted =
        buildJourneySnapshot();
    const journey =
        exhausted.entities[0]
            .journey;
    const route =
        exhausted.routes[
            journey.routeId
        ];

    journey.legIndex =
        route.legs.length;

    assert.throws(
        () =>
            validateWorldCoreSnapshot(
                exhausted,
            ),
        /active journey has no remaining leg or entry point/,
    );

    const pointOutsideRoad =
        buildJourneySnapshot();

    pointOutsideRoad.entities[0]
        .journey.pointIndex =
        999;

    assert.throws(
        () =>
            validateWorldCoreSnapshot(
                pointOutsideRoad,
            ),
        /outside current road point range/,
    );

    const prefix =
        buildPrefixSnapshot();

    prefix.entities[0]
        .journey.legIndex =
        1;

    assert.throws(
        () =>
            validateWorldCoreSnapshot(
                prefix,
            ),
        /prefix leg requires legIndex 0/,
    );
});

test("prefix segment index must stay within current road geometry", () => {
    const snapshot =
        buildPrefixSnapshot();

    snapshot.entities[0]
        .journey.prefixLeg
        .startSegmentIndex =
        999;

    assert.throws(
        () =>
            validateWorldCoreSnapshot(
                snapshot,
            ),
        /outside road segment range/,
    );
});

test("empty movement LOD arrays are rejected because canonical snapshots normalize them to null", () => {
    const snapshot =
        buildJourneySnapshot();

    snapshot.world
        .movementLodTiers =
        [];

    assert.throws(
        () =>
            validateWorldCoreSnapshot(
                snapshot,
            ),
        /expected null or a non-empty array/,
    );
});

test("persisted entity movement interval must be finite and non-negative even while idle", () => {
    const navigation =
        buildNavigation();
    const world =
        new World();

    world.addEntity({
        id: "idle",
        position: {
            x: 0,
            y: 0,
        },
        simulation: {
            movementInterval: 5,
        },
    });

    const valid =
        serializeWorldCore(
            world,
            navigation,
        );

    assert.equal(
        validateWorldCoreSnapshot(
            valid,
        ),
        true,
    );

    const negative =
        structuredClone(valid);

    negative.entities[0]
        .entity.simulation
        .movementInterval =
        -1;

    assert.throws(
        () =>
            validateWorldCoreSnapshot(
                negative,
            ),
        /expected number >= 0/,
    );

    const nan =
        structuredClone(valid);

    nan.entities[0]
        .entity.simulation
        .movementInterval =
        Number.NaN;

    assert.throws(
        () =>
            validateWorldCoreSnapshot(
                nan,
            ),
        /expected finite number/,
    );
});

test("scheduler accumulator validation matches distance LOD buckets exactly", () => {
    const canonical =
        buildLodSnapshot();

    assert.deepEqual(
        canonical.world
            .movementAccumulators,
        [[10, 0]],
    );

    assert.equal(
        validateWorldCoreSnapshot(
            canonical,
        ),
        true,
    );

    const duplicate =
        structuredClone(
            canonical,
        );

    duplicate.world
        .movementAccumulators
        .push([10, 0]);

    assert.throws(
        () =>
            validateWorldCoreSnapshot(
                duplicate,
            ),
        /duplicate movement interval/,
    );

    const missing =
        structuredClone(
            canonical,
        );

    missing.world
        .movementAccumulators =
        [];

    assert.throws(
        () =>
            validateWorldCoreSnapshot(
                missing,
            ),
        /missing scheduled interval 10/,
    );

    const unexpected =
        structuredClone(
            canonical,
        );

    unexpected.world
        .movementAccumulators =
        [[99, 0]];

    assert.throws(
        () =>
            validateWorldCoreSnapshot(
                unexpected,
            ),
        /interval has no scheduled movers/,
    );

    const overflowed =
        structuredClone(
            canonical,
        );

    overflowed.world
        .movementAccumulators =
        [[10, 11]];

    assert.throws(
        () =>
            validateWorldCoreSnapshot(
                overflowed,
            ),
        /accumulated time is outside scheduler range/,
    );
});

test("scheduler validation accepts simulation-region intervals that are not distance LOD tiers", () => {
    const navigation =
        buildNavigation();
    const world = new World({
        simulationRegions: [
            {
                id: "background",
                minX: -5,
                minY: -5,
                maxX: 25,
                maxY: 5,
                detailLevel:
                    "background",
                movementInterval: 7,
            },
        ],
    });

    world.addEntity({
        id: "walker",
        position: {
            x: 0,
            y: 0,
        },
        mobility:
            mobilityProfile(
                "pedestrian",
            ),
    });

    startJourney(
        world,
        navigation,
        "walker",
        "c",
    );

    const snapshot =
        serializeWorldCore(
            world,
            navigation,
        );

    assert.deepEqual(
        snapshot.world
            .movementAccumulators,
        [[7, 0]],
    );

    assert.equal(
        validateWorldCoreSnapshot(
            snapshot,
        ),
        true,
    );
});

test("scheduler validation accepts explicit mover intervals independent of world LOD policy", () => {
    const navigation =
        buildNavigation();
    const world =
        new World();

    world.addEntity({
        id: "walker",
        position: {
            x: 0,
            y: 0,
        },
        mobility:
            mobilityProfile(
                "pedestrian",
            ),
    });

    startJourney(
        world,
        navigation,
        "walker",
        "c",
    );

    world.setMovementInterval(
        "walker",
        3,
    );

    const snapshot =
        serializeWorldCore(
            world,
            navigation,
        );

    assert.deepEqual(
        snapshot.world
            .movementAccumulators,
        [[3, 0]],
    );

    assert.equal(
        validateWorldCoreSnapshot(
            snapshot,
        ),
        true,
    );
});


test("public position changes immediately reclassify moving entities for region LOD snapshots", () => {
    const navigation =
        buildNavigation();
    const world = new World({
        simulationRegions: [
            {
                id: "coarse",
                minX: -5,
                minY: -5,
                maxX: 5,
                maxY: 5,
                movementInterval: 7,
            },
        ],
    });

    world.addEntity({
        id: "walker",
        position: {
            x: 0,
            y: 0,
        },
        mobility:
            mobilityProfile(
                "pedestrian",
            ),
    });

    startJourney(
        world,
        navigation,
        "walker",
        "c",
    );

    assert.deepEqual(
        serializeWorldCore(
            world,
            navigation,
        ).world.movementAccumulators,
        [[7, 0]],
    );

    world.setPosition(
        "walker",
        {
            x: 10,
            y: 0,
        },
    );

    const snapshot =
        serializeWorldCore(
            world,
            navigation,
        );

    assert.deepEqual(
        snapshot.world
            .movementAccumulators,
        [],
    );

    assert.equal(
        validateWorldCoreSnapshot(
            snapshot,
        ),
        true,
    );

    const restored =
        deserializeWorldCore(
            structuredClone(
                snapshot,
            ),
        );

    assert.equal(
        restored.world
            .entityMovementIntervals
            .has("walker"),
        false,
    );
});


test("public setEntityPositionXY also reclassifies moving entities without affecting the movement hot path contract", () => {
    const navigation =
        buildNavigation();
    const world = new World({
        simulationRegions: [
            {
                id: "coarse",
                minX: -5,
                minY: -5,
                maxX: 5,
                maxY: 5,
                movementInterval: 7,
            },
        ],
    });

    world.addEntity({
        id: "walker",
        position: {
            x: 10,
            y: 0,
        },
        mobility:
            mobilityProfile(
                "pedestrian",
            ),
    });

    startJourney(
        world,
        navigation,
        "walker",
        "c",
    );

    assert.equal(
        world.entityMovementIntervals
            .has("walker"),
        false,
    );

    const walker =
        world.getEntity("walker");

    world.setEntityPositionXY(
        walker,
        0,
        0,
    );

    assert.equal(
        world.entityMovementIntervals
            .get("walker"),
        7,
    );

    const snapshot =
        serializeWorldCore(
            world,
            navigation,
        );

    assert.deepEqual(
        snapshot.world
            .movementAccumulators,
        [[7, 0]],
    );

    assert.equal(
        validateWorldCoreSnapshot(
            snapshot,
        ),
        true,
    );
});
