import assert from "node:assert/strict";
import test from "node:test";

import {
    computeWorldCoreStateHash,
    deserializeWorldCore,
    mobilityProfile,
    Navigation,
    serializeWorldCore,
    startJourney,
    stepSimulation,
    validateWorldCoreSnapshot,
    World,
} from "world-core";

function buildMiniCity() {
    const navigation = new Navigation({
        spatialCellSize: 10,
    });

    navigation.addNode({
        id: "west-gate",
        x: 0,
        y: 0,
    });
    navigation.addNode({
        id: "market-square",
        x: 20,
        y: 0,
        junctionRadius: 3,
    });
    navigation.addNode({
        id: "market",
        x: 40,
        y: 0,
    });
    navigation.addNode({
        id: "harbor",
        x: 20,
        y: 20,
        junctionRadius: 2,
    });

    navigation.addRoad({
        id: "gate-road",
        from: "west-gate",
        to: "market-square",
        width: 6,
        surface: "street",
    });
    navigation.addRoad({
        id: "market-road",
        from: "market-square",
        to: "market",
        width: 5,
        surface: "street",
    });
    navigation.addRoad({
        id: "harbor-road",
        from: "market-square",
        to: "harbor",
        width: 5,
        surface: "road",
    });
    navigation.addRoad({
        id: "harbor-market",
        from: "harbor",
        to: "market",
        width: 5,
        surface: "road",
    });

    const world = new World({
        spatialCellSize: 4,
        obstacleCellSize: 4,
        captureEvents: true,
        eventQueueLimit: 256,
        eventOverflowPolicy: "drop-newest",
        localSteering: {
            neighborRadius: 3,
            obstacleLookahead: 4,
            separationStrength: 0.8,
            maxLateralSpeed: 1,
            congestionStrength: 0.5,
            trafficSide: "right",
        },
    });

    world.addObstacle({
        id: "market-stall",
        type: "aabb",
        minX: 23,
        minY: -0.8,
        maxX: 25,
        maxY: 0.8,
        tags: ["stall"],
    });

    const pedestrian =
        mobilityProfile("pedestrian");

    for (let i = 0; i < 24; i++) {
        const eastbound =
            i % 2 === 0;
        const id =
            `citizen-${String(i).padStart(2, "0")}`;

        world.addEntity({
            id,
            kind: "person",
            position:
                eastbound
                    ? { x: 0, y: 0 }
                    : { x: 40, y: 0 },
            body: {
                radius:
                    0.28 +
                    (i % 3) * 0.03,
            },
            mobility: pedestrian,
            householdId:
                Math.floor(i / 3),
        });

        assert.equal(
            startJourney(
                world,
                navigation,
                id,
                eastbound
                    ? "market"
                    : "west-gate",
            ),
            true,
        );
    }

    return {
        world,
        navigation,
    };
}

test("package-level mini-city consumer survives routing changes and save/restore", () => {
    let {
        world,
        navigation,
    } = buildMiniCity();

    let observedEvents = 0;

    for (let tick = 1; tick <= 160; tick++) {
        if (tick === 30) {
            navigation.setRoadEffect(
                "market-procession",
                "market-road",
                {
                    blocked: true,
                },
            );
        }

        if (tick === 90) {
            navigation.clearRoadEffect(
                "market-procession",
            );
        }

        stepSimulation(
            world,
            navigation,
            0.2,
        );

        if (tick % 20 === 0) {
            observedEvents +=
                world.drainEvents().length;
        }

        if (tick === 80) {
            const before =
                computeWorldCoreStateHash(
                    world,
                    navigation,
                );

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
                validateWorldCoreSnapshot(
                    snapshot,
                ),
                true,
            );

            const restored =
                deserializeWorldCore(
                    snapshot,
                );

            world =
                restored.world;
            navigation =
                restored.navigation;

            assert.equal(
                computeWorldCoreStateHash(
                    world,
                    navigation,
                ),
                before,
            );
        }
    }

    observedEvents +=
        world.drainEvents().length;

    assert.ok(observedEvents > 0);
    assert.equal(
        world.droppedEventCount,
        0,
    );

    for (const entity of world.entities.values()) {
        assert.ok(
            Number.isFinite(
                entity.position.x,
            ),
        );
        assert.ok(
            Number.isFinite(
                entity.position.y,
            ),
        );
    }

    assert.ok(
        world.queryRadius(
            { x: 20, y: 0 },
            30,
        ).length > 0,
    );

    world.assertInternalConsistency();
    navigation.assertInternalConsistency();
});

test("navigation ids reject values outside the documented string contract", () => {
    const navigation = new Navigation();

    assert.throws(
        () =>
            navigation.addNode({
                id: 1,
                x: 0,
                y: 0,
            }),
        /non-empty string/,
    );

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

    assert.throws(
        () =>
            navigation.addRoad({
                id: "",
                from: "a",
                to: "b",
            }),
        /non-empty string/,
    );
});
