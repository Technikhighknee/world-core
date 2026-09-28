import {
    Navigation,
    World,
    mobilityProfile,
    startJourney,
    stepSimulation,
} from "../src/index.js";

const world = new World({
    spatialCellSize: 10,
});

const navigation = new Navigation();

navigation.addNode({
    id: "west-gate",
    x: 0,
    y: 0,
});

navigation.addNode({
    id: "market",
    x: 100,
    y: 0,
});

navigation.addNode({
    id: "harbor",
    x: 160,
    y: 70,
});

navigation.addRoad({
    id: "west-road",
    from: "west-gate",
    to: "market",
    width: 5,
    surface: "street",
    shape: [
        { x: 30, y: 2 },
        { x: 60, y: -1 },
        { x: 80, y: 1 },
    ],
});

navigation.addRoad({
    id: "harbor-road",
    from: "market",
    to: "harbor",
    width: 4,
    surface: "street",
    shape: [
        { x: 120, y: 15 },
        { x: 140, y: 40 },
    ],
});

world.addEntity({
    id: "merchant",
    kind: "person",
    position: {
        x: 0,
        y: 0,
    },
    body: {
        radius: 0.35,
    },
    mobility: mobilityProfile("pedestrian"),
});

startJourney(
    world,
    navigation,
    "merchant",
    "market",
);

for (let seconds = 1; seconds <= 100; seconds++) {
    stepSimulation(
        world,
        navigation,
        1,
    );

    const merchant =
        world.getEntity("merchant");

    console.log(
        `t=${world.time}s`,
        `merchant=(${merchant.position.x.toFixed(2)}, ${merchant.position.y.toFixed(2)})`,
    );
}
