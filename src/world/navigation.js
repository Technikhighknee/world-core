import { closestPointOnPolyline, polylineLength } from "./geometry.js";
import { MinPriorityQueue } from "./priority-queue.js";
import { StaticSpatialIndex } from "./static-spatial-index.js";
import { distance } from "./vec2.js";

function mobilityCacheKey(mobility) {
    if (mobility.profileId) {
        return mobility.profileId;
    }

    if (mobility.cacheKey) {
        return mobility.cacheKey;
    }

    const multipliers = mobility.surfaceMultipliers ?? {};
    const keys = Object.keys(multipliers).sort();

    let key = `speed:${mobility.speed}`;

    for (const surface of keys) {
        key += `|${surface}:${multipliers[surface]}`;
    }

    return key;
}

function maxTravelSpeed(mobility) {
    const multipliers = mobility.surfaceMultipliers ?? {};
    let maxMultiplier = 1;

    for (const value of Object.values(multipliers)) {
        if (value > maxMultiplier) {
            maxMultiplier = value;
        }
    }

    return mobility.speed * maxMultiplier;
}

export class Navigation {
    constructor({ spatialCellSize = 50, routeCacheSize = 5000 } = {}) {
        this.nodes = new Map();
        this.roads = new Map();
        this.adjacency = new Map();

        this.nodeIndex = new StaticSpatialIndex(spatialCellSize);
        this.roadIndex = new StaticSpatialIndex(spatialCellSize);

        this.routeCacheSize = routeCacheSize;
        this.routeCache = new Map();
        this.graphVersion = 0;
    }

    #invalidateRoutes() {
        this.graphVersion++;
        this.routeCache.clear();
    }

    #cacheRoute(key, route) {
        if (this.routeCacheSize <= 0) return;

        if (this.routeCache.has(key)) {
            this.routeCache.delete(key);
        }

        this.routeCache.set(key, route);

        while (this.routeCache.size > this.routeCacheSize) {
            const oldestKey = this.routeCache.keys().next().value;
            this.routeCache.delete(oldestKey);
        }
    }

    addNode({ id, x, y }) {
        if (this.nodes.has(id)) {
            throw new Error(`Navigation node already exists: ${id}`);
        }

        const node = { id, position: { x, y } };

        this.nodes.set(id, node);
        this.adjacency.set(id, []);
        this.nodeIndex.insertPoint(id, node.position);
        this.#invalidateRoutes();

        return node;
    }

    addRoad({
        id,
        from,
        to,
        shape = [],
        width = 4,
        surface = "street",
        bidirectional = true,
    }) {
        if (this.roads.has(id)) {
            throw new Error(`Road already exists: ${id}`);
        }

        const start = this.nodes.get(from);
        const end = this.nodes.get(to);

        if (!start || !end) {
            throw new Error(`Road ${id} references unknown nodes`);
        }

        const points = [
            { ...start.position },
            ...shape.map(point => ({ ...point })),
            { ...end.position },
        ];

        const road = {
            id,
            from,
            to,
            width,
            surface,
            bidirectional,
            points,
            length: polylineLength(points),
        };

        this.roads.set(id, road);
        this.adjacency.get(from).push({ roadId: id, from, to, reversed: false });

        if (bidirectional) {
            this.adjacency.get(to).push({
                roadId: id,
                from: to,
                to: from,
                reversed: true,
            });
        }

        const padding = width / 2;

        for (let i = 1; i < points.length; i++) {
            const a = points[i - 1];
            const b = points[i];

            this.roadIndex.insertBounds(
                id,
                Math.min(a.x, b.x) - padding,
                Math.min(a.y, b.y) - padding,
                Math.max(a.x, b.x) + padding,
                Math.max(a.y, b.y) + padding,
            );
        }

        this.#invalidateRoutes();
        return road;
    }

    nodeAt(position, tolerance = 0.01) {
        const candidates = this.nodeIndex.queryRadius(position, tolerance);
        let best = null;

        for (const nodeId of candidates) {
            const node = this.nodes.get(nodeId);
            if (!node) continue;

            const d = distance(node.position, position);
            if (d > tolerance) continue;

            if (!best || d < best.distance) {
                best = { node, distance: d };
            }
        }

        return best?.node ?? null;
    }

    nearestNode(position) {
        if (this.nodes.size === 0) return null;

        let radius = this.nodeIndex.cellSize;

        for (let attempt = 0; attempt < 24; attempt++) {
            const candidates = this.nodeIndex.queryRadius(position, radius);

            if (candidates.size > 0) {
                let best = null;

                for (const nodeId of candidates) {
                    const node = this.nodes.get(nodeId);
                    if (!node) continue;

                    const d = distance(position, node.position);

                    if (!best || d < best.distance) {
                        best = { node, distance: d };
                    }
                }

                if (best && best.distance <= radius) return best;
            }

            radius *= 2;
        }

        let best = null;

        for (const node of this.nodes.values()) {
            const d = distance(position, node.position);

            if (!best || d < best.distance) {
                best = { node, distance: d };
            }
        }

        return best;
    }

    roadAt(position, extraTolerance = 0) {
        const candidates = extraTolerance > 0
            ? this.roadIndex.queryRadius(position, extraTolerance)
            : this.roadIndex.queryPoint(position);

        let best = null;

        for (const roadId of candidates) {
            const road = this.roads.get(roadId);
            if (!road) continue;

            const closest = closestPointOnPolyline(position, road.points);
            if (!closest) continue;

            const allowedDistance = road.width / 2 + extraTolerance;
            if (closest.distance > allowedDistance) continue;

            if (!best || closest.distance < best.distance) {
                best = { road, ...closest };
            }
        }

        return best;
    }

    findRoute(startNodeId, destinationNodeId, mobility) {
        const start = this.nodes.get(startNodeId);
        const destination = this.nodes.get(destinationNodeId);

        if (!start) {
            throw new Error(`Unknown start node: ${startNodeId}`);
        }

        if (!destination) {
            throw new Error(`Unknown destination node: ${destinationNodeId}`);
        }

        if (!(mobility?.speed > 0)) return null;

        if (startNodeId === destinationNodeId) {
            return {
                startNodeId,
                destinationNodeId,
                legs: [],
                estimatedSeconds: 0,
            };
        }

        const cacheKey =
            `${this.graphVersion}|${startNodeId}|${destinationNodeId}|${mobilityCacheKey(mobility)}`;

        const cached = this.routeCache.get(cacheKey);

        if (cached) {
            this.routeCache.delete(cacheKey);
            this.routeCache.set(cacheKey, cached);
            return cached;
        }

        const fastestPossibleSpeed = maxTravelSpeed(mobility);
        if (!(fastestPossibleSpeed > 0)) return null;

        const queue = new MinPriorityQueue();
        const costs = new Map([[startNodeId, 0]]);
        const previous = new Map();

        queue.push(
            startNodeId,
            distance(start.position, destination.position) / fastestPossibleSpeed,
        );

        while (queue.size > 0) {
            const currentEntry = queue.pop();
            const current = currentEntry.value;
            const currentCost = costs.get(current);

            if (current === destinationNodeId) break;

            const currentNode = this.nodes.get(current);
            const expectedPriority =
                currentCost +
                distance(currentNode.position, destination.position) / fastestPossibleSpeed;

            if (currentEntry.priority > expectedPriority + 1e-9) {
                continue;
            }

            for (const edge of this.adjacency.get(current) ?? []) {
                const road = this.roads.get(edge.roadId);
                if (!road) continue;

                const multiplier = mobility.surfaceMultipliers?.[road.surface] ?? 1;
                if (!(multiplier > 0)) continue;

                const speed = mobility.speed * multiplier;
                if (!(speed > 0)) continue;

                const nextCost = currentCost + road.length / speed;
                const knownCost = costs.get(edge.to) ?? Infinity;

                if (nextCost >= knownCost) continue;

                costs.set(edge.to, nextCost);
                previous.set(edge.to, { previousNode: current, edge });

                const nextNode = this.nodes.get(edge.to);
                const heuristic =
                    distance(nextNode.position, destination.position) / fastestPossibleSpeed;

                queue.push(edge.to, nextCost + heuristic);
            }
        }

        if (!previous.has(destinationNodeId)) return null;

        const edges = [];
        let nodeId = destinationNodeId;

        while (nodeId !== startNodeId) {
            const step = previous.get(nodeId);
            if (!step) return null;

            edges.push(step.edge);
            nodeId = step.previousNode;
        }

        edges.reverse();

        const legs = edges.map(edge => {
            const road = this.roads.get(edge.roadId);

            return {
                roadId: road.id,
                from: edge.from,
                to: edge.to,
                points: edge.reversed
                    ? [...road.points].reverse().map(point => ({ ...point }))
                    : road.points.map(point => ({ ...point })),
            };
        });

        const route = {
            startNodeId,
            destinationNodeId,
            legs,
            estimatedSeconds: costs.get(destinationNodeId),
        };

        this.#cacheRoute(cacheKey, route);
        return route;
    }
}
