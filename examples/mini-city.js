import {
    deserializeWorldCore,
    mobilityProfile,
    Navigation,
    serializeWorldCore,
    startJourney,
    stepSimulation,
    World,
} from "world-core";

let navigation = new Navigation();
let world = new World({
    captureEvents: true,
    eventQueueLimit: 256,
    localSteering: {
        neighborRadius: 3,
        obstacleLookahead: 4,
    },
});

navigation.addNode({
    id: "gate",
    x: 0,
    y: 0,
});
navigation.addNode({
    id: "square",
    x: 30,
    y: 0,
    junctionRadius: 3,
});
navigation.addNode({
    id: "market",
    x: 60,
    y: 0,
});
navigation.addNode({
    id: "harbor",
    x: 30,
    y: 30,
});

navigation.addRoad({
    id: "gate-road",
    from: "gate",
    to: "square",
    width: 6,
});
navigation.addRoad({
    id: "market-road",
    from: "square",
    to: "market",
    width: 5,
});
navigation.addRoad({
    id: "harbor-road",
    from: "square",
    to: "harbor",
    width: 5,
});
navigation.addRoad({
    id: "harbor-market",
    from: "harbor",
    to: "market",
    width: 5,
});

world.addObstacle({
    id: "stall",
    type: "circle",
    center: {
        x: 38,
        y: 0,
    },
    radius: 1,
});

for (let i = 0; i < 12; i++) {
    const id =
        `citizen-${i}`;

    world.addEntity({
        id,
        kind: "person",
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
        id,
        "market",
    );
}

for (let tick = 1; tick <= 200; tick++) {
    if (tick === 50) {
        navigation.setRoadEffect(
            "procession",
            "market-road",
            {
                blocked: true,
            },
        );
    }

    if (tick === 120) {
        navigation.clearRoadEffect(
            "procession",
        );
    }

    stepSimulation(
        world,
        navigation,
        0.2,
    );

    if (tick === 100) {
        const snapshot =
            serializeWorldCore(
                world,
                navigation,
            );

        ({
            world,
            navigation,
        } = deserializeWorldCore(
            JSON.parse(
                JSON.stringify(
                    snapshot,
                ),
            ),
        ));
    }
}

console.log(
    `time=${world.time.toFixed(1)}s entities=${world.entities.size} movers=${world.movingEntities.size}`,
);
console.log(
    world.drainEvents().slice(-10),
);
