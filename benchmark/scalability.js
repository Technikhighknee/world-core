import { performance } from "node:perf_hooks";

import { Navigation } from "../src/world/navigation.js";
import { startJourney } from "../src/world/movement.js";
import { stepSimulation } from "../src/world/simulation.js";
import { World } from "../src/world/world.js";

const cityCount = 20;
const entitiesPerCity = 2500;
const moversPerCity = 250;
const ticks = 100;
const citySpacing = 10000;

const world = new World({ spatialCellSize: 10 });
const navigation = new Navigation({
    spatialCellSize: 25,
    routeCacheSize: 10000,
});

for (let city = 0; city < cityCount; city++) {
    const originX = city * citySpacing;
    const startId = `city-${city}-start`;
    const endId = `city-${city}-end`;

    navigation.addNode({ id: startId, x: originX, y: 0 });
    navigation.addNode({ id: endId, x: originX + 1000, y: 0 });
    navigation.addRoad({
        id: `city-${city}-road`,
        from: startId,
        to: endId,
        width: 6,
    });

    for (let i = 0; i < entitiesPerCity; i++) {
        const entityId = `city-${city}-person-${i}`;
        const moving = i < moversPerCity;

        world.addEntity({
            id: entityId,
            kind: "person",
            position: moving
                ? { x: originX, y: 0 }
                : {
                    x: originX + 100 + (i % 100),
                    y: 50 + Math.floor(i / 100),
                },
            mobility: { speed: 1.4 },
        });

        if (moving) {
            startJourney(world, navigation, entityId, endId);
        }
    }
}

console.log(`entities: ${world.entities.size.toLocaleString()}`);
console.log(`active movers: ${world.movingEntities.size.toLocaleString()}`);
console.log(`cities: ${cityCount}`);
console.log(`ticks: ${ticks}`);

const started = performance.now();

for (let i = 0; i < ticks; i++) {
    stepSimulation(world, navigation, 1);
}

const elapsed = performance.now() - started;

console.log(`movement total: ${elapsed.toFixed(2)} ms`);
console.log(`movement per tick: ${(elapsed / ticks).toFixed(3)} ms`);
console.log(`active movers after run: ${world.movingEntities.size.toLocaleString()}`);

const thiefPosition = { x: 100, y: 50 };
const queryStarted = performance.now();
let nearbyCount = 0;

for (let i = 0; i < 10000; i++) {
    nearbyCount += world.queryRadius(thiefPosition, 8).length;
}

const queryElapsed = performance.now() - queryStarted;

console.log(`10,000 nearby queries: ${queryElapsed.toFixed(2)} ms`);
console.log(`query checksum: ${nearbyCount}`);
