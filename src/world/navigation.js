import { distance } from "./vec2.js";
import { closestPointOnPolyline, polylineLength } from "./geometry.js";

export class Navigation {
    constructor() {
        this.nodes = new Map();
        this.roads = new Map();
        this.adjacency = new Map();
    }

    addNode({ id, x, y }) {
        if (this.nodes.has(id)) {
            throw new Error(`Navigation node already exists: ${id}`);
        }

        const node = { id, position: { x, y } }
        
        this.nodes.set(id, node);
        this.adjacency.set(id, []);

        return node;
    }

    addRoad({
        id, from, to,
        shape = [],
        width = 4,
        surface = "street",
        bidirectional = true
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
            { ...end.position }
        ];
        
        const road = {
            id, from, to,
            width, 
            surface, 
            bidirectional,
            points,
            length: polylineLength(points)
        }

        this.roads.set(id, road);
        
        this.adjacency
            .get(from)
            .push({ roadId: id, from, to, reversed: false });
        
        if (bidirectional) {
            this.adjacency
                .get(to)
                .push({ roadId: id, from: to, to: from, reversed: true });
        }

        return road;
    }

    nodeAt(position, tolerance = 0.01) {
        let best = null;

        for (const node of this.nodes.values()) {
            const d = distance(node.position, position);
            if (d > tolerance) continue;

            if (!best || d < best.distance) {
                best = { node, distance: d };
            }
        }

        return best?.node ?? null;
    }

    nearestNode(position) {
        let best = null;

        for (const node of this.nodes.values()) {
            const d = distance(position, node.position);

            if (!best || d < best.distance) {
                best = { node, distance: d }
            };
        }

        return best;
    }

    roadAt(position, extraTolerance = 0) {
        let best = null;

        for (const road of this.roads.values()) {
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
        if (!this.nodes.has(startNodeId)) {
            throw new Error(`Unknown start node: ${startNodeId}`);
        }

        if (!this.nodes.has(destinationNodeId)) {
            throw new Error(`Unknown destination node: ${destinationNodeId}`);
        }

        if (startNodeId === destinationNodeId) {
            return {
                startNodeId,
                destinationNodeId,
                legs: [],
                estimatedSeconds: 0,
            };
        }

        const distances = new Map();
        const previous = new Map();
        const unvisited = new Set(this.nodes.keys());

        for (const nodeId of unvisited) {
            distances.set(nodeId, Infinity);
        }

        distances.set(startNodeId, 0);

        while (unvisited.size > 0) {
            let current = null;
            let currentCost = Infinity;

            for (const nodeId of unvisited) {
                const cost = distances.get(nodeId);

                if (cost < currentCost) {
                    current = nodeId;
                    currentCost = cost;
                }
            }

            if (current === null || currentCost === Infinity) {
                break;
            }

            unvisited.delete(current);
            
            if (current === destinationNodeId) {
                break;
            }

            const edges = this.adjacency.get(current) ?? [];
            
            for (const edge of edges) {
                if (!unvisited.has(edge.to)) continue;

                const road = this.roads.get(edge.roadId);

                const multiplier = mobility.surfaceMultipliers?.[road.surface] ?? 1;
                if (multiplier <= 0) continue;

                const speed = mobility.speed * multiplier;
                if (speed <= 0) continue;

                const travelTime = road.length / speed;
                const alternative = currentCost + travelTime

                if (alternative < distances.get(edge.to)) {
                    distances.set(edge.to, alternative);
                    previous.set(edge.to, { previousNode: current, edge });
                }
            }
        }

        if (!previous.has(destinationNodeId)) return null;

        const edges = [];
        let nodeId = destinationNodeId;

        while(nodeId !== startNodeId) {
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
                    ? [...road.points]
                        .reverse()
                        .map(point => ({ ...point }))
                    : road.points.map(point => ({ ...point }))
            }
        });

        return {
            startNodeId,
            destinationNodeId,
            legs,
            estimatedSeconds: distances.get(destinationNodeId)
        };
    }
}
