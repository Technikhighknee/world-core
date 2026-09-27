import { Navigation } from "../../src/world/navigation.js";

export function nodeId(city, x, y) {
    return `city-${city}-node-${x}-${y}`;
}

export function cityOriginX(city, citySpacing) {
    return city * citySpacing;
}

export function buildCityNavigation({
    cityCount = 20,
    gridSize = 20,
    nodeSpacing = 50,
    citySpacing = 10000,
    routeCacheSize = 20000,
    routeCacheMaxLegs = 256,
    routeCacheMaxTotalLegs = 100000,
} = {}) {
    const navigation = new Navigation({
        spatialCellSize: nodeSpacing,
        routeCacheSize,
        routeCacheMaxLegs,
        routeCacheMaxTotalLegs,
    });

    const startedAt = performance.now();

    for (let city = 0; city < cityCount; city++) {
        const originX = cityOriginX(city, citySpacing);

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
                        surface: (x * 3 + y) % 11 === 0
                            ? "mud"
                            : "street",
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

    return {
        navigation,
        buildMs: performance.now() - startedAt,
    };
}

export function createRouteQueries({
    count,
    cityCount,
    gridSize,
    seed = 0x12345678,
}) {
    let state = seed >>> 0;
    const queries = [];
    const seen = new Set();

    function nextInt(max) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state % max;
    }

    while (queries.length < count) {
        const city = nextInt(cityCount);
        const sourceX = nextInt(gridSize);
        const sourceY = nextInt(gridSize);
        const destinationX = nextInt(gridSize);
        const destinationY = nextInt(gridSize);

        if (sourceX === destinationX && sourceY === destinationY) {
            continue;
        }

        const key =
            `${city}:${sourceX}:${sourceY}:${destinationX}:${destinationY}`;

        if (seen.has(key)) continue;
        seen.add(key);

        queries.push({
            city,
            sourceX,
            sourceY,
            destinationX,
            destinationY,
            from: nodeId(city, sourceX, sourceY),
            to: nodeId(city, destinationX, destinationY),
        });
    }

    return queries;
}

export function createRng(seed = 0x9e3779b9) {
    let state = seed >>> 0;

    return {
        nextInt(max) {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
            return state % max;
        },

        nextFloat() {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
            return state / 0x100000000;
        },
    };
}
