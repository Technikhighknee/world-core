import { closestPointOnPolyline, polylineLength } from "./geometry.js";
import { MinPriorityQueue } from "./priority-queue.js";
import { StaticSpatialIndex } from "./static-spatial-index.js";
import { distance } from "./vec2.js";

const EPSILON = 1e-9;

function mobilityCacheKey(mobility) {
    if (mobility.profileId) return mobility.profileId;
    if (mobility.cacheKey) return mobility.cacheKey;

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
        if (value > maxMultiplier) maxMultiplier = value;
    }

    return mobility.speed * maxMultiplier;
}

function roadSpeed(road, mobility) {
    const multiplier = mobility.surfaceMultipliers?.[road.surface] ?? 1;
    return mobility.speed * multiplier;
}

export class Navigation {
    constructor({
        spatialCellSize = 50,
        routeCacheSize = 5000,
        routeCacheMaxLegs = 256,
        routeCacheMaxTotalLegs = 100000,
    } = {}) {
        this.nodes = new Map();
        this.roads = new Map();
        this.adjacency = new Map();

        this.nodeIndex = new StaticSpatialIndex(spatialCellSize);
        this.roadIndex = new StaticSpatialIndex(spatialCellSize);
        this.maxRoadHalfWidth = 0;

        this.routeCacheSize = routeCacheSize;
        this.routeCacheMaxLegs = routeCacheMaxLegs;
        this.routeCacheMaxTotalLegs = routeCacheMaxTotalLegs;
        this.routeCache = new Map();
        this.routeCacheLegCount = 0;

        this.componentMembers = new Map();
        this.nextComponentId = 1;

        this.nodeQueryScratch = new Set();
        this.roadQueryScratch = new Set();
    }

    #deleteCachedRoute(key) {
        const entry = this.routeCache.get(key);
        if (!entry) return false;

        this.routeCache.delete(key);
        this.routeCacheLegCount -= entry.route.legs.length;

        return true;
    }

    #invalidateComponent(componentId) {
        for (const [key, entry] of this.routeCache) {
            if (entry.componentId === componentId) {
                this.#deleteCachedRoute(key);
            }
        }
    }

    #mergeComponents(a, b) {
        if (a === b) return a;

        const membersA = this.componentMembers.get(a);
        const membersB = this.componentMembers.get(b);

        if (!membersA || !membersB) {
            throw new Error("Navigation component bookkeeping is inconsistent");
        }

        this.#invalidateComponent(a);
        this.#invalidateComponent(b);

        let keepId = a;
        let mergeId = b;
        let keep = membersA;
        let merge = membersB;

        if (membersB.size > membersA.size) {
            keepId = b;
            mergeId = a;
            keep = membersB;
            merge = membersA;
        }

        for (const nodeId of merge) {
            this.nodes.get(nodeId).componentId = keepId;
            keep.add(nodeId);
        }

        this.componentMembers.delete(mergeId);
        return keepId;
    }

    #cacheRoute(key, route, componentId) {
        if (
            this.routeCacheSize <= 0 ||
            route.legs.length > this.routeCacheMaxLegs
        ) {
            return;
        }

        if (this.routeCache.has(key)) {
            this.#deleteCachedRoute(key);
        }

        const entry = { route, componentId };
        this.routeCache.set(key, entry);
        this.routeCacheLegCount += route.legs.length;

        while (
            this.routeCache.size > this.routeCacheSize ||
            this.routeCacheLegCount > this.routeCacheMaxTotalLegs
        ) {
            const oldestKey = this.routeCache.keys().next().value;
            this.#deleteCachedRoute(oldestKey);
        }
    }

    invalidateRoadRoutes(roadId) {
        const road = this.roads.get(roadId);
        if (!road) return;

        const componentId = this.nodes.get(road.from)?.componentId;
        if (componentId != null) this.#invalidateComponent(componentId);
    }

    invalidateAllRoutes() {
        this.routeCache.clear();
        this.routeCacheLegCount = 0;
    }

    addNode({ id, x, y }) {
        if (this.nodes.has(id)) {
            throw new Error(`Navigation node already exists: ${id}`);
        }

        const componentId = this.nextComponentId++;
        const node = {
            id,
            position: { x, y },
            componentId,
        };

        this.nodes.set(id, node);
        this.adjacency.set(id, []);
        this.componentMembers.set(componentId, new Set([id]));
        this.nodeIndex.insertPoint(id, node.position);

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

        const componentId = start.componentId === end.componentId
            ? start.componentId
            : this.#mergeComponents(start.componentId, end.componentId);

        if (start.componentId === end.componentId) {
            this.#invalidateComponent(componentId);
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
        this.adjacency.get(from).push({ roadId: id, to, reversed: false });

        if (bidirectional) {
            this.adjacency.get(to).push({
                roadId: id,
                to: from,
                reversed: true,
            });
        }

        this.maxRoadHalfWidth = Math.max(
            this.maxRoadHalfWidth,
            width / 2,
        );

        for (let i = 1; i < points.length; i++) {
            this.roadIndex.insertSegment(
                id,
                points[i - 1],
                points[i],
            );
        }

        return road;
    }

    setRoadSurface(roadId, surface) {
        const road = this.roads.get(roadId);

        if (!road) {
            throw new Error(`Unknown road: ${roadId}`);
        }

        if (road.surface === surface) return false;

        road.surface = surface;
        this.invalidateRoadRoutes(roadId);
        return true;
    }

    nodeAt(position, tolerance = 0.01) {
        const candidates = this.nodeIndex.queryRadiusInto(
            this.nodeQueryScratch,
            position,
            tolerance,
        );

        let best = null;
        let bestDistance = Infinity;

        for (const nodeId of candidates) {
            const node = this.nodes.get(nodeId);
            if (!node) continue;

            const d = distance(node.position, position);

            if (d <= tolerance && d < bestDistance) {
                best = node;
                bestDistance = d;
            }
        }

        return best;
    }

    nearestNode(position) {
        return this.nearestNodeWithDistance(position)?.node ?? null;
    }

    nearestNodeWithDistance(position) {
        if (this.nodes.size === 0) return null;

        let radius = this.nodeIndex.cellSize;

        for (let attempt = 0; attempt < 24; attempt++) {
            const candidates = this.nodeIndex.queryRadiusInto(
                this.nodeQueryScratch,
                position,
                radius,
            );

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
        const searchRadius =
            this.maxRoadHalfWidth + extraTolerance;

        const candidates = searchRadius > 0
            ? this.roadIndex.queryRadiusInto(
                this.roadQueryScratch,
                position,
                searchRadius,
            )
            : this.roadIndex.queryPointInto(
                this.roadQueryScratch,
                position,
            );

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

    findRouteFromPosition(position, destinationNodeId, mobility, {
        nodeTolerance = 0.1,
        roadTolerance = 0,
    } = {}) {
        const node = this.nodeAt(position, nodeTolerance);

        if (node) {
            const route = this.findRoute(node.id, destinationNodeId, mobility);
            if (!route) return null;

            return {
                route,
                prefixLeg: null,
                entryPoint: null,
                estimatedSeconds: route.estimatedSeconds,
            };
        }

        const hit = this.roadAt(position, roadTolerance);
        if (!hit) return null;

        const road = hit.road;
        const speed = roadSpeed(road, mobility);
        if (!(speed > 0)) return null;

        const entrySeconds = distance(position, hit.point) / mobility.speed;
        let best = null;

        const consider = (endpointNodeId, reversed, partialDistance) => {
            const baseRoute = this.findRoute(endpointNodeId, destinationNodeId, mobility);
            if (!baseRoute) return;

            const partialSeconds = partialDistance / speed;
            const totalSeconds =
                entrySeconds + partialSeconds + baseRoute.estimatedSeconds;

            const prefixLeg = partialDistance > EPSILON
                ? {
                    roadId: road.id,
                    reversed,
                    startSegmentIndex: hit.segmentIndex,
                }
                : null;

            const candidate = {
                route: baseRoute,
                prefixLeg,
                entryPoint: distance(position, hit.point) > EPSILON
                    ? { ...hit.point }
                    : null,
                estimatedSeconds: totalSeconds,
            };

            if (!best || totalSeconds < best.estimatedSeconds) {
                best = candidate;
            }
        };

        consider(
            road.to,
            false,
            road.length - hit.distanceAlong,
        );

        if (road.bidirectional) {
            consider(
                road.from,
                true,
                hit.distanceAlong,
            );
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
        if (start.componentId !== destination.componentId) return null;

        if (startNodeId === destinationNodeId) {
            return {
                startNodeId,
                destinationNodeId,
                legs: [],
                estimatedSeconds: 0,
            };
        }

        const cacheKey =
            `${startNodeId}|${destinationNodeId}|${mobilityCacheKey(mobility)}`;

        const cached = this.routeCache.get(cacheKey);

        if (cached) {
            this.routeCache.delete(cacheKey);
            this.routeCache.set(cacheKey, cached);
            return cached.route;
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

            if (currentCost == null) continue;
            if (current === destinationNodeId) break;

            const currentNode = this.nodes.get(current);
            const expectedPriority =
                currentCost +
                distance(currentNode.position, destination.position) /
                    fastestPossibleSpeed;

            if (currentEntry.priority > expectedPriority + EPSILON) {
                continue;
            }

            for (const edge of this.adjacency.get(current) ?? []) {
                const road = this.roads.get(edge.roadId);
                if (!road) continue;

                const speed = roadSpeed(road, mobility);
                if (!(speed > 0)) continue;

                const nextCost = currentCost + road.length / speed;
                const knownCost = costs.get(edge.to) ?? Infinity;

                if (nextCost >= knownCost) continue;

                costs.set(edge.to, nextCost);
                previous.set(edge.to, {
                    previousNode: current,
                    roadId: edge.roadId,
                    reversed: edge.reversed,
                });

                const nextNode = this.nodes.get(edge.to);
                const heuristic =
                    distance(nextNode.position, destination.position) /
                    fastestPossibleSpeed;

                queue.push(edge.to, nextCost + heuristic);
            }
        }

        if (!previous.has(destinationNodeId)) return null;

        const legs = [];
        let nodeId = destinationNodeId;

        while (nodeId !== startNodeId) {
            const step = previous.get(nodeId);
            if (!step) return null;

            legs.push({
                roadId: step.roadId,
                reversed: step.reversed,
            });

            nodeId = step.previousNode;
        }

        legs.reverse();

        const route = {
            startNodeId,
            destinationNodeId,
            legs,
            estimatedSeconds: costs.get(destinationNodeId),
        };

        this.#cacheRoute(cacheKey, route, start.componentId);
        return route;
    }
}
