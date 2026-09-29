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

