import assert from "node:assert/strict";
import test from "node:test";

import {
    deserializeWorldCore,
    Navigation,
    serializeWorldCore,
    startJourney,
    validateWorldCoreSnapshot,
    World,
} from "../src/index.js";

function createValidSnapshot() {
    const navigation = new Navigation({
        spatialCellSize: 10,
    });

    navigation.addNode({
        id: "a",
        x: 0,
        y: 0,
    });
    navigation.addNode({
        id: "b",
        x: 20,
        y: 0,
    });

    navigation.addRoad({
        id: "road",
        from: "a",
        to: "b",
        width: 4,
    });

    const world = new World({
        spatialCellSize: 5,
        obstacleCellSize: 5,
    });

    world.addObstacle({
        id: "barrier",
        type: "circle",
        center: {
            x: 10,
            y: 2,
        },
        radius: 0.5,
    });

    world.addEntity({
        id: "walker",
        position: {
            x: 0,
            y: 0,
        },
        body: {
            radius: 0.35,
        },
        mobility: {
            profileId:
                "snapshot-test",
            speed: 1,
        },
    });

    startJourney(
        world,
        navigation,
        "walker",
        "b",
    );

    return serializeWorldCore(
        world,
        navigation,
    );
}

function expectInvalid(
    mutate,
    expected,
) {
    const snapshot =
        structuredClone(
            createValidSnapshot(),
        );

    mutate(snapshot);

    assert.throws(
        () =>
            validateWorldCoreSnapshot(
                snapshot,
            ),
        expected,
    );

    assert.throws(
        () =>
            deserializeWorldCore(
                snapshot,
            ),
        expected,
    );
}

test("valid snapshots pass explicit validation", () => {
    const snapshot =
        createValidSnapshot();

    assert.equal(
        validateWorldCoreSnapshot(
            snapshot,
        ),
        true,
    );
});

test("snapshot validation rejects duplicate entity ids", () => {
    expectInvalid(
        snapshot => {
            snapshot.entities.push(
                structuredClone(
                    snapshot.entities[0],
                ),
            );
        },
        /duplicate id walker/,
    );
});

test("snapshot validation rejects roads referencing missing nodes", () => {
    expectInvalid(
        snapshot => {
            snapshot.navigation.roads[0].to =
                "missing";
        },
        /references missing node/,
    );
});

test("snapshot validation rejects invalid entity body radii and coordinates", () => {
    expectInvalid(
        snapshot => {
            snapshot.entities[0]
                .entity.body.radius = -1;
        },
        /expected number >= 0/,
    );

    expectInvalid(
        snapshot => {
            snapshot.entities[0]
                .entity.position.x =
                Number.NaN;
        },
        /expected finite number/,
    );
});

test("snapshot validation rejects broken journey references", () => {
    expectInvalid(
        snapshot => {
            snapshot.entities[0]
                .journey.routeId = 999;
        },
        /references missing route/,
    );

    expectInvalid(
        snapshot => {
            snapshot.routes[0]
                .legs[0].roadId =
                "ghost-road";
        },
        /references missing road/,
    );
});

test("snapshot validation rejects malformed execution order", () => {
    expectInvalid(
        snapshot => {
            snapshot.entityOrder = [
                "walker",
                "walker",
            ];
        },
        /duplicate entity id/,
    );

    expectInvalid(
        snapshot => {
            snapshot.movingOrder = [
                "missing",
            ];
        },
        /references missing entity/,
    );
});

test("snapshot validation rejects invalid obstacle geometry", () => {
    expectInvalid(
        snapshot => {
            snapshot.world.obstacles[0]
                .radius = -1;
        },
        /expected number >= 0/,
    );

    expectInvalid(
        snapshot => {
            snapshot.world.obstacles[0]
                .type = "polygon";
        },
        /unsupported obstacle type/,
    );
});

test("snapshot validation rejects invalid road effects and cache bounds", () => {
    expectInvalid(
        snapshot => {
            snapshot.navigation
                .roads[0].effects = [{
                    id: "traffic",
                    blocked: false,
                    costMultiplier: 0.5,
                }];
        },
        /expected number >= 1/,
    );

    expectInvalid(
        snapshot => {
            snapshot.navigation
                .routeCacheSize = -1;
        },
        /expected integer >= 0/,
    );
});

test("snapshot validation rejects disconnected route legs and incomplete moving order", () => {
    expectInvalid(
        snapshot => {
            snapshot.routes[0].legs[0].reversed =
                true;
        },
        /route leg is not connected|one-way road in reverse/,
    );

    expectInvalid(
        snapshot => {
            snapshot.movingOrder = [];
        },
        /must contain every entity with an active journey exactly once/,
    );
});


test("snapshot validation rejects invalid event queue configuration", () => {
    expectInvalid(
        snapshot => {
            snapshot.world.eventQueueLimit =
                -1;
        },
        /expected integer >= 0/,
    );

    expectInvalid(
        snapshot => {
            snapshot.world.eventOverflowPolicy =
                "unbounded";
        },
        /unsupported event overflow policy/,
    );
});
