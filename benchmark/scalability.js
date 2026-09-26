import { performance } from "node:perf_hooks";

import { mobilityProfile } from "../src/world/mobility-profiles.js";
import { Navigation } from "../src/world/navigation.js";
import { startJourney } from "../src/world/movement.js";
import { stepSimulation } from "../src/world/simulation.js";
import { World } from "../src/world/world.js";

const cityCount = 20;
const gridSize = 20;
const nodeSpacing = 50;
const entitiesPerCity = 2500;
const moversPerCity = 250;
const ticks = 100;
const citySpacing = 10000;
const routeQueries = 2000;

const pedestrian = mobilityProfile("pedestrian");
const world = new World({ spatialCellSize: 10 });
const navigation = new Navigation({
    spatialCellSize: 50,
    routeCacheSize: 20000,
});

function nodeId(city, x, y) {
    return `city-${city}-node-${x}-${y}`;
}

function addCityGraph(city) {
    const originX = city * citySpacing;

    for (let y = 0; y < gridSize; y++) {
        for (let x = 0; x < gridSize; x++) {
            navigation.addNode({
                id: nodeId(city, x, y),
                x: originX + x * nodeSpacing,
                y: y * nodeSpacing,
            });
        }
    }

    for (let y = 0; y < gridSize; y++) {
        for (let x = 0; x < gridSize; x++) {
            if (x + 1 < gridSize) {
                const from = nodeId(city, x, y);
                const to = nodeId(city, x + 1, y);
                const baseX = originX + x * nodeSpacing;
                const baseY = y * nodeSpacing;

                navigation.addRoad({
                    id: `city-${city}-h-${x}-${y}`,
                    from,
                    to,
                    width: 5,
                    surface: (x + y) % 7 === 0 ? "mud" : "street",
                    shape: [
                        { x: baseX + 12.5, y: baseY + 1.5 },
                        { x: baseX + 25, y: baseY - 1.5 },
                        { x: baseX + 37.5, y: baseY + 1 },
                    ],
                });
            }

            if (y + 1 < gridSize) {
                const from = nodeId(city, x, y);
                const to = nodeId(city, x, y + 1);
                const baseX = originX + x * nodeSpacing;
                const baseY = y * nodeSpacing;

                navigation.addRoad({
                    id: `city-${city}-v-${x}-${y}`,
                    from,
                    to,
                    width: 4,
                    surface: (x * 3 + y) % 11 === 0 ? "mud" : "street",
                    shape: [
                        { x: baseX + 1.5, y: baseY + 12.5 },
                        { x: baseX - 1, y: baseY + 25 },
                        { x: baseX + 1, y: baseY + 37.5 },
                    ],
                });
            }
        }
    }
}

const buildStarted = performance.now();

for (let city = 0; city < cityCount; city++) {
    addCityGraph(city);
}

const graphBuildElapsed = performance.now() - buildStarted;

const coldRoutingStarted = performance.now();

for (let i = 0; i < routeQueries; i++) {
    const city = i % cityCount;
    const sourceX = (i * 7) % gridSize;
    const sourceY = (i * 11) % gridSize;
    const destinationX = (gridSize - 1 - sourceX + gridSize) % gridSize;
    const destinationY = (gridSize - 1 - sourceY + gridSize) % gridSize;

    if (sourceX === destinationX && sourceY === destinationY) continue;

    navigation.findRoute(
        nodeId(city, sourceX, sourceY),
        nodeId(city, destinationX, destinationY),
        pedestrian,
    );
}

const coldRoutingElapsed = performance.now() - coldRoutingStarted;
const warmRoutingStarted = performance.now();

for (let i = 0; i < routeQueries; i++) {
    const city = i % cityCount;
    const sourceX = (i * 7) % gridSize;
    const sourceY = (i * 11) % gridSize;
    const destinationX = (gridSize - 1 - sourceX + gridSize) % gridSize;
    const destinationY = (gridSize - 1 - sourceY + gridSize) % gridSize;

    if (sourceX === destinationX && sourceY === destinationY) continue;

    navigation.findRoute(
        nodeId(city, sourceX, sourceY),
        nodeId(city, destinationX, destinationY),
        pedestrian,
    );
}

const warmRoutingElapsed = performance.now() - warmRoutingStarted;

for (let city = 0; city < cityCount; city++) {
    const originX = city * citySpacing;

    for (let i = 0; i < entitiesPerCity; i++) {
        const entityId = `city-${city}-person-${i}`;
        const moving = i < moversPerCity;

        world.addEntity({
            id: entityId,
            kind: "person",
            position: moving
                ? {
                    x: originX,
                    y: 0,
                }
                : {
                    x: originX + 100 + (i % 100),
                    y: 100 + Math.floor(i / 100),
                },
            mobility: pedestrian,
        });

        if (moving) {
            startJourney(
                world,
                navigation,
                entityId,
                nodeId(city, gridSize - 1, gridSize - 1),
            );
        }
    }
}

console.log(`cities: ${cityCount}`);
console.log(`nodes: ${navigation.nodes.size.toLocaleString()}`);
console.log(`roads: ${navigation.roads.size.toLocaleString()}`);
console.log(`entities: ${world.entities.size.toLocaleString()}`);
console.log(`active movers: ${world.movingEntities.size.toLocaleString()}`);
console.log(`graph build: ${graphBuildElapsed.toFixed(2)} ms`);
console.log(`cold route queries (${routeQueries}): ${coldRoutingElapsed.toFixed(2)} ms`);
console.log(`warm route queries (${routeQueries}): ${warmRoutingElapsed.toFixed(2)} ms`);

const movementStarted = performance.now();

for (let i = 0; i < ticks; i++) {
    stepSimulation(world, navigation, 1);
}

const movementElapsed = performance.now() - movementStarted;

console.log(`movement ticks: ${ticks}`);
console.log(`movement total: ${movementElapsed.toFixed(2)} ms`);
console.log(`movement per tick: ${(movementElapsed / ticks).toFixed(3)} ms`);
console.log(`active movers after run: ${world.movingEntities.size.toLocaleString()}`);

const thiefPosition = { x: 100, y: 100 };
const queryStarted = performance.now();
let nearbyCount = 0;

for (let i = 0; i < 10000; i++) {
    nearbyCount += world.queryRadius(thiefPosition, 8).length;
}

const queryElapsed = performance.now() - queryStarted;

console.log(`10,000 nearby queries: ${queryElapsed.toFixed(2)} ms`);
console.log(`query checksum: ${nearbyCount}`);
