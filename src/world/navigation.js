import {
    closestPointOnPolyline,
    polylineLength,
} from "./geometry.js";
import { MinPriorityQueue } from "./priority-queue.js";
import { StaticSpatialIndex } from "./static-spatial-index.js";
import { distance } from "./vec2.js";

const EPSILON = 1e-9;

function sortedUnique(values) {
    if (values == null) return null;
    return [...new Set(values)].sort();
}

function mobilityCacheKey(mobility) {
    if (mobility.profileId) return mobility.profileId;
    if (mobility.cacheKey) return mobility.cacheKey;

    const multipliers = mobility.surfaceMultipliers ?? {};
    const multiplierKeys = Object.keys(multipliers).sort();
    const requiredTags = [...(mobility.requiredRoadTags ?? [])].sort();
    const blockedTags = [...(mobility.blockedRoadTags ?? [])].sort();

    let key =
        `speed:${mobility.speed}` +
        `|width:${mobility.requiredRoadWidth ?? 0}` +
        `|requiredTags:${requiredTags.join(",")}` +
        `|blockedTags:${blockedTags.join(",")}`;

    for (const surface of multiplierKeys) {
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

function roadSurfaceSpeed(road, mobility) {
    const multiplier =
        mobility.surfaceMultipliers?.[road.surface] ?? 1;

    return mobility.speed * multiplier;
}

function profileAllowed(road, mobility) {
    const profileId = mobility.profileId ?? null;

    if (
        road.allowedProfiles &&
        (!profileId || !road.allowedProfiles.includes(profileId))
    ) {
        return false;
    }

    if (
        profileId &&
        road.blockedProfiles?.includes(profileId)
    ) {
        return false;
    }

    return true;
}

function tagsAllowed(road, mobility) {
    const tags = road.tags ?? [];

    for (const tag of mobility.requiredRoadTags ?? []) {
        if (!tags.includes(tag)) return false;
    }

    for (const tag of mobility.blockedRoadTags ?? []) {
        if (tags.includes(tag)) return false;
    }

    return true;
}

function compareAdjacencyEdges(a, b) {
    if (a.roadId < b.roadId) return -1;
    if (a.roadId > b.roadId) return 1;
    if (a.to < b.to) return -1;
    if (a.to > b.to) return 1;
    return (
        Number(a.reversed) -
        Number(b.reversed)
    );
}

export class Navigation {
    constructor({
        spatialCellSize = 50,
        routeCacheSize = 5000,
        routeCacheMaxLegs = 256,
        routeCacheMaxTotalLegs = 100000,
        hierarchicalRouteCacheSize = 1000,
        regionalRouteCacheSize = 5000,
    } = {}) {
        this.nodes = new Map();
        this.roads = new Map();
        this.adjacency = new Map();
        this.roadEffects = new Map();

        this.regions = new Map();
        this.hierarchicalRouteCacheSize =
            hierarchicalRouteCacheSize;
        this.regionalRouteCacheSize =
            regionalRouteCacheSize;
        this.hierarchicalRouteCache =
            new Map();
        this.regionalRouteCache =
            new Map();
        this.regionGatewayCache =
            new Map();
        this.hierarchyRevision = -1;

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
        this.graphRevision = 0;

        this.nodeQueryScratch = new Set();
        this.roadQueryScratch = new Set();
    }

    #touchGraph() {
        this.graphRevision++;
        this.hierarchyRevision = -1;
        this.hierarchicalRouteCache.clear();
        this.regionalRouteCache.clear();
        this.regionGatewayCache.clear();
    }

    #deleteCachedRoute(key) {
        const entry = this.routeCache.get(key);
        if (!entry) return false;

        this.routeCache.delete(key);
        this.routeCacheLegCount -= entry.route.legs.length;

        return true;
    }

    #invalidateComponent(componentId) {
        if (componentId == null) return;

        for (const [key, entry] of this.routeCache) {
            if (entry.componentId === componentId) {
                this.#deleteCachedRoute(key);
            }
        }
    }

    #invalidateComponentsForNodes(nodeIds) {
        const componentIds = new Set();

        for (const nodeId of nodeIds) {
            const componentId = this.nodes.get(nodeId)?.componentId;
            if (componentId != null) componentIds.add(componentId);
        }

        for (const componentId of componentIds) {
            this.#invalidateComponent(componentId);
        }
    }

    #invalidateRoutesUsingRoads(roadIds) {
        const ids = roadIds instanceof Set
            ? roadIds
            : new Set(roadIds);

        for (const [key, entry] of this.routeCache) {
            if (
                entry.route.legs.some(
                    leg => ids.has(leg.roadId),
                )
            ) {
                this.#deleteCachedRoute(key);
            }
        }
    }

    #invalidateRoutesTouchingNodes(nodeIds) {
        const ids = nodeIds instanceof Set
            ? nodeIds
            : new Set(nodeIds);

        for (const [key, entry] of this.routeCache) {
            const route = entry.route;

            if (
                ids.has(route.startNodeId) ||
                ids.has(route.destinationNodeId)
            ) {
                this.#deleteCachedRoute(key);
            }
        }
    }

    #mergeComponents(a, b) {
        if (a === b) return a;

        const membersA = this.componentMembers.get(a);
        const membersB = this.componentMembers.get(b);

        if (!membersA || !membersB) {
            throw new Error(
                "Navigation component bookkeeping is inconsistent",
            );
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

    #rebuildComponents() {
        this.componentMembers.clear();
        this.nextComponentId = 1;

        const neighbors = new Map();

        for (const nodeId of this.nodes.keys()) {
            neighbors.set(nodeId, []);
        }

        for (const road of this.roads.values()) {
            if (!road.enabled) continue;

            neighbors.get(road.from)?.push(road.to);
            neighbors.get(road.to)?.push(road.from);
        }

        for (const list of neighbors.values()) {
            list.sort();
        }

        const unvisited = new Set(
            [...this.nodes.keys()].sort(),
        );

        while (unvisited.size > 0) {
            const startId =
                unvisited.values().next().value;
            const componentId =
                this.nextComponentId++;
            const members = new Set();
            const queue = [startId];

            unvisited.delete(startId);

            for (
                let index = 0;
                index < queue.length;
                index++
            ) {
                const nodeId = queue[index];
                const node =
                    this.nodes.get(nodeId);

                if (!node) continue;

                node.componentId = componentId;
                members.add(nodeId);

                for (
                    const neighborId of
                    neighbors.get(nodeId) ?? []
                ) {
                    if (
                        !unvisited.has(
                            neighborId,
                        )
                    ) {
                        continue;
                    }

                    unvisited.delete(neighborId);
                    queue.push(neighborId);
                }
            }

            this.componentMembers.set(
                componentId,
                members,
            );
        }

        this.#refreshCachedComponentIds();
    }

    #refreshCachedComponentIds() {
        for (const [key, entry] of this.routeCache) {
            const start = this.nodes.get(
                entry.route.startNodeId,
            );
            const destination = this.nodes.get(
                entry.route.destinationNodeId,
            );

            if (
                !start ||
                !destination ||
                start.componentId !== destination.componentId
            ) {
                this.#deleteCachedRoute(key);
                continue;
            }

            entry.componentId = start.componentId;
        }
    }

    #sortAdjacency(nodeId) {
        const edges = this.adjacency.get(nodeId);
        if (!edges) return;

        edges.sort(
            compareAdjacencyEdges,
        );
    }

    #recalculateMaxRoadHalfWidth() {
        let max = 0;

        for (const road of this.roads.values()) {
            max = Math.max(max, road.width / 2);
        }

        this.maxRoadHalfWidth = max;
    }

    #indexRoad(road) {
        for (let i = 1; i < road.points.length; i++) {
            this.roadIndex.insertSegment(
                road.id,
                road.points[i - 1],
                road.points[i],
            );
        }
    }

    #removeRoadInternal(roadId) {
        const road = this.roads.get(roadId);
        if (!road) return null;

        const removeFromAdjacency = nodeId => {
            const edges = this.adjacency.get(nodeId);
            if (!edges) return;

            for (let i = edges.length - 1; i >= 0; i--) {
                if (edges[i].roadId === roadId) {
                    edges.splice(i, 1);
                }
            }
        };

        removeFromAdjacency(road.from);
        removeFromAdjacency(road.to);

        this.roadIndex.remove(roadId);
        this.roadEffects.delete(roadId);
        this.roads.delete(roadId);

        return road;
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
            this.routeCacheLegCount >
                this.routeCacheMaxTotalLegs
        ) {
            const oldestKey =
                this.routeCache.keys().next().value;

            this.#deleteCachedRoute(oldestKey);
        }
    }

    invalidateRoadRoutes(roadId) {
        if (!this.roads.has(roadId)) return;

        this.#invalidateRoutesUsingRoads([roadId]);
    }

    invalidateAllRoutes() {
        this.routeCache.clear();
        this.routeCacheLegCount = 0;
    }

    addRegion({ id }) {
        if (
            typeof id !== "string" ||
            id.length === 0
        ) {
            throw new Error(
                "Navigation region id must be a non-empty string",
            );
        }

        if (this.regions.has(id)) {
            throw new Error(
                `Navigation region already exists: ${id}`,
            );
        }

        const region = {
            id,
            nodeIds: new Set(),
        };

        this.regions.set(id, region);
        this.#touchGraph();

        return region;
    }

    removeRegion(regionId) {
        const region =
            this.regions.get(regionId);

        if (!region) return false;

        if (region.nodeIds.size > 0) {
            throw new Error(
                `Cannot remove non-empty navigation region: ${regionId}`,
            );
        }

        this.regions.delete(regionId);
        this.#touchGraph();
        return true;
    }

    setNodeRegion(
        nodeId,
        regionId,
    ) {
        const node =
            this.nodes.get(nodeId);

        if (!node) {
            throw new Error(
                `Unknown node: ${nodeId}`,
            );
        }

        if (
            regionId !== null &&
            regionId !== undefined &&
            !this.regions.has(regionId)
        ) {
            throw new Error(
                `Unknown navigation region: ${regionId}`,
            );
        }

        const nextRegionId =
            regionId ?? null;

        if (
            node.regionId ===
            nextRegionId
        ) {
            return false;
        }

        if (node.regionId != null) {
            this.regions
                .get(node.regionId)
                ?.nodeIds.delete(nodeId);
        }

        node.regionId =
            nextRegionId;

        if (nextRegionId != null) {
            this.regions
                .get(nextRegionId)
                .nodeIds.add(nodeId);
        }

        this.#touchGraph();
        return true;
    }

    #refreshRegionGateways() {
        if (
            this.hierarchyRevision ===
            this.graphRevision
        ) {
            return;
        }

        this.regionGatewayCache.clear();

        for (const regionId of this.regions.keys()) {
            this.regionGatewayCache.set(
                regionId,
                new Set(),
            );
        }

        for (const road of this.roads.values()) {
            const from =
                this.nodes.get(road.from);
            const to =
                this.nodes.get(road.to);

            if (
                !from ||
                !to ||
                from.regionId == null ||
                to.regionId == null ||
                from.regionId ===
                    to.regionId
            ) {
                continue;
            }

            this.regionGatewayCache
                .get(from.regionId)
                ?.add(from.id);
            this.regionGatewayCache
                .get(to.regionId)
                ?.add(to.id);
        }

        this.hierarchyRevision =
            this.graphRevision;
    }

    getRegionGateways(regionId) {
        if (!this.regions.has(regionId)) {
            throw new Error(
                `Unknown navigation region: ${regionId}`,
            );
        }

        this.#refreshRegionGateways();

        return [
            ...(
                this.regionGatewayCache
                    .get(regionId) ??
                []
            ),
        ]
            .sort()
            .map(nodeId =>
                this.nodes.get(nodeId));
    }

    #setBoundedCache(
        cache,
        key,
        value,
        limit,
    ) {
        if (!(limit > 0)) {
            return value;
        }

        if (cache.has(key)) {
            cache.delete(key);
        }

        cache.set(key, value);

        while (cache.size > limit) {
            cache.delete(
                cache.keys().next().value,
            );
        }

        return value;
    }

    addNode({
        id,
        x,
        y,
        junctionRadius = 0,
        regionId = null,
    }) {
        if (
            typeof id !== "string" ||
            id.length === 0
        ) {
            throw new Error(
                "Navigation node id must be a non-empty string",
            );
        }

        if (this.nodes.has(id)) {
            throw new Error(
                `Navigation node already exists: ${id}`,
            );
        }

        if (!(junctionRadius >= 0)) {
            throw new Error(
                "Navigation node junctionRadius must be greater than or equal to 0",
            );
        }

        if (
            regionId !== null &&
            !this.regions.has(regionId)
        ) {
            throw new Error(
                `Unknown navigation region: ${regionId}`,
            );
        }

        const componentId = this.nextComponentId++;
        const node = {
            id,
            position: { x, y },
            junctionRadius,
            regionId,
            componentId,
        };

        this.nodes.set(id, node);
        this.adjacency.set(id, []);
        this.componentMembers.set(
            componentId,
            new Set([id]),
        );
        this.nodeIndex.insertPoint(id, node.position);

        if (regionId != null) {
            this.regions
                .get(regionId)
                .nodeIds.add(id);
        }

        this.#touchGraph();

        return node;
    }

    setNodeJunctionRadius(
        nodeId,
        junctionRadius,
    ) {
        if (!(junctionRadius >= 0)) {
            throw new Error(
                "Navigation node junctionRadius must be greater than or equal to 0",
            );
        }

        const node =
            this.nodes.get(nodeId);

        if (!node) {
            throw new Error(
                `Unknown node: ${nodeId}`,
            );
        }

        if (
            node.junctionRadius ===
            junctionRadius
        ) {
            return false;
        }

        node.junctionRadius =
            junctionRadius;
        this.#touchGraph();

        return true;
    }

    removeNode(nodeId) {
        const node = this.nodes.get(nodeId);
        if (!node) return false;

        const connectedRoadIds = new Set(
            (this.adjacency.get(nodeId) ?? [])
                .map(edge => edge.roadId),
        );

        this.#invalidateRoutesTouchingNodes([nodeId]);
        this.#invalidateRoutesUsingRoads(connectedRoadIds);

        for (const roadId of connectedRoadIds) {
            this.#removeRoadInternal(roadId);
        }

        this.nodeIndex.remove(nodeId);
        this.adjacency.delete(nodeId);

        if (node.regionId != null) {
            this.regions
                .get(node.regionId)
                ?.nodeIds.delete(nodeId);
        }

        this.nodes.delete(nodeId);

        this.#recalculateMaxRoadHalfWidth();
        this.#rebuildComponents();
        this.#touchGraph();

        return true;
    }

    addRoad({
        id,
        from,
        to,
        shape = [],
        width = 4,
        surface = "street",
        bidirectional = true,
        enabled = true,
        allowedProfiles = null,
        blockedProfiles = [],
        tags = [],
    }) {
        if (
            typeof id !== "string" ||
            id.length === 0
        ) {
            throw new Error(
                "Road id must be a non-empty string",
            );
        }

        if (
            typeof from !== "string" ||
            from.length === 0 ||
            typeof to !== "string" ||
            to.length === 0
        ) {
            throw new Error(
                "Road endpoint ids must be non-empty strings",
            );
        }

        if (this.roads.has(id)) {
            throw new Error(
                `Road already exists: ${id}`,
            );
        }

        const start = this.nodes.get(from);
        const end = this.nodes.get(to);

        if (!start || !end) {
            throw new Error(
                `Road ${id} references unknown nodes`,
            );
        }

        if (!(width > 0)) {
            throw new Error(
                `Road ${id} width must be greater than 0`,
            );
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
            enabled,
            allowedProfiles: sortedUnique(allowedProfiles),
            blockedProfiles:
                sortedUnique(blockedProfiles) ?? [],
            tags: sortedUnique(tags) ?? [],
            points,
            length: polylineLength(points),
            version: 1,
        };

        if (enabled) {
            const componentId =
                start.componentId === end.componentId
                    ? start.componentId
                    : this.#mergeComponents(
                        start.componentId,
                        end.componentId,
                    );

            if (start.componentId === end.componentId) {
                this.#invalidateComponent(componentId);
            }
        }

        this.roads.set(id, road);
        this.adjacency.get(from).push({
            roadId: id,
            to,
            reversed: false,
        });

        if (bidirectional) {
            this.adjacency.get(to).push({
                roadId: id,
                to: from,
                reversed: true,
            });
        }

        this.#sortAdjacency(from);
        this.#sortAdjacency(to);

        this.maxRoadHalfWidth = Math.max(
            this.maxRoadHalfWidth,
            width / 2,
        );

        this.#indexRoad(road);
        this.#touchGraph();

        return road;
    }

    removeRoad(roadId) {
        const road = this.roads.get(roadId);
        if (!road) return false;

        this.#invalidateRoutesUsingRoads([roadId]);

        this.#removeRoadInternal(roadId);
        this.#recalculateMaxRoadHalfWidth();
        this.#rebuildComponents();
        this.#touchGraph();

        return true;
    }

    setRoadEnabled(roadId, enabled) {
        const road = this.roads.get(roadId);

        if (!road) {
            throw new Error(`Unknown road: ${roadId}`);
        }

        enabled = Boolean(enabled);
        if (road.enabled === enabled) return false;

        if (enabled) {
            this.#invalidateComponentsForNodes([
                road.from,
                road.to,
            ]);
        } else {
            this.#invalidateRoutesUsingRoads([roadId]);
        }

        road.enabled = enabled;
        road.version++;

        this.#rebuildComponents();
        this.#touchGraph();

        return true;
    }

    setRoadSurface(roadId, surface) {
        const road = this.roads.get(roadId);

        if (!road) {
            throw new Error(`Unknown road: ${roadId}`);
        }

        if (road.surface === surface) return false;

        this.#invalidateComponentsForNodes([
            road.from,
            road.to,
        ]);

        road.surface = surface;
        road.version++;
        this.#touchGraph();

        return true;
    }

    setRoadWidth(roadId, width) {
        if (!(width > 0)) {
            throw new Error(
                "Road width must be greater than 0",
            );
        }

        const road = this.roads.get(roadId);

        if (!road) {
            throw new Error(`Unknown road: ${roadId}`);
        }

        if (road.width === width) return false;

        this.#invalidateComponentsForNodes([
            road.from,
            road.to,
        ]);

        road.width = width;
        road.version++;

        this.#recalculateMaxRoadHalfWidth();
        this.#touchGraph();

        return true;
    }

    setRoadAccess(
        roadId,
        {
            allowedProfiles,
            blockedProfiles,
            tags,
        } = {},
    ) {
        const road = this.roads.get(roadId);

        if (!road) {
            throw new Error(`Unknown road: ${roadId}`);
        }

        const nextAllowed =
            allowedProfiles === undefined
                ? road.allowedProfiles
                : sortedUnique(allowedProfiles);

        const nextBlocked =
            blockedProfiles === undefined
                ? road.blockedProfiles
                : sortedUnique(blockedProfiles) ?? [];

        const nextTags =
            tags === undefined
                ? road.tags
                : sortedUnique(tags) ?? [];

        const same =
            JSON.stringify(nextAllowed) ===
                JSON.stringify(road.allowedProfiles) &&
            JSON.stringify(nextBlocked) ===
                JSON.stringify(road.blockedProfiles) &&
            JSON.stringify(nextTags) ===
                JSON.stringify(road.tags);

        if (same) return false;

        this.#invalidateComponentsForNodes([
            road.from,
            road.to,
        ]);

        road.allowedProfiles = nextAllowed;
        road.blockedProfiles = nextBlocked;
        road.tags = nextTags;
        road.version++;

        this.#touchGraph();
        return true;
    }

    setRoadBidirectional(roadId, bidirectional) {
        const road = this.roads.get(roadId);

        if (!road) {
            throw new Error(`Unknown road: ${roadId}`);
        }

        bidirectional = Boolean(bidirectional);
        if (road.bidirectional === bidirectional) {
            return false;
        }

        this.#invalidateComponentsForNodes([
            road.from,
            road.to,
        ]);

        const reverseEdges =
            this.adjacency.get(road.to) ?? [];

        if (bidirectional) {
            reverseEdges.push({
                roadId,
                to: road.from,
                reversed: true,
            });
            this.#sortAdjacency(road.to);
        } else {
            for (
                let i = reverseEdges.length - 1;
                i >= 0;
                i--
            ) {
                if (
                    reverseEdges[i].roadId === roadId &&
                    reverseEdges[i].reversed
                ) {
                    reverseEdges.splice(i, 1);
                }
            }
        }

        road.bidirectional = bidirectional;
        road.version++;

        this.#rebuildComponents();
        this.#touchGraph();

        return true;
    }

    replaceRoadGeometry(roadId, shape = []) {
        const road = this.roads.get(roadId);

        if (!road) {
            throw new Error(`Unknown road: ${roadId}`);
        }

        const start = this.nodes.get(road.from);
        const end = this.nodes.get(road.to);

        if (!start || !end) {
            throw new Error(
                `Road ${roadId} has missing endpoint nodes`,
            );
        }

        this.#invalidateComponentsForNodes([
            road.from,
            road.to,
        ]);

        this.roadIndex.remove(roadId);

        road.points = [
            { ...start.position },
            ...shape.map(point => ({ ...point })),
            { ...end.position },
        ];
        road.length = polylineLength(road.points);
        road.version++;

        this.#indexRoad(road);
        this.#touchGraph();

        return road;
    }

    setRoadEffect(
        effectId,
        roadId,
        {
            blocked = false,
            costMultiplier = 1,
            traversalDelaySeconds = 0,
        } = {},
    ) {
        if (!effectId) {
            throw new Error(
                "Road effect id is required",
            );
        }

        if (
            !Number.isFinite(
                costMultiplier,
            ) ||
            costMultiplier < 1
        ) {
            throw new Error(
                "Road effect costMultiplier must be finite and greater than or equal to 1",
            );
        }

        if (
            !Number.isFinite(
                traversalDelaySeconds,
            ) ||
            traversalDelaySeconds < 0
        ) {
            throw new Error(
                "Road effect traversalDelaySeconds must be finite and greater than or equal to 0",
            );
        }

        const road =
            this.roads.get(roadId);

        if (!road) {
            throw new Error(
                `Unknown road: ${roadId}`,
            );
        }

        let effects =
            this.roadEffects.get(
                roadId,
            );

        if (!effects) {
            effects = new Map();
            this.roadEffects.set(
                roadId,
                effects,
            );
        }

        const next = {
            blocked: Boolean(blocked),
            costMultiplier,
            traversalDelaySeconds,
        };
        const previous =
            effects.get(effectId);

        if (
            previous &&
            previous.blocked ===
                next.blocked &&
            previous.costMultiplier ===
                next.costMultiplier &&
            previous.traversalDelaySeconds ===
                next.traversalDelaySeconds
        ) {
            return false;
        }

        this.#invalidateComponentsForNodes([
            road.from,
            road.to,
        ]);

        effects.set(
            effectId,
            next,
        );
        road.version++;
        this.#touchGraph();

        return true;
    }

    removeRoadEffect(
        effectId,
        roadId,
    ) {
        const road =
            this.roads.get(roadId);

        if (!road) {
            throw new Error(
                `Unknown road: ${roadId}`,
            );
        }

        const effects =
            this.roadEffects.get(
                roadId,
            );

        if (
            !effects ||
            !effects.has(effectId)
        ) {
            return false;
        }

        this.#invalidateComponentsForNodes([
            road.from,
            road.to,
        ]);

        effects.delete(effectId);

        if (effects.size === 0) {
            this.roadEffects.delete(
                roadId,
            );
        }

        road.version++;
        this.#touchGraph();

        return true;
    }

    clearRoadEffect(effectId) {
        let changed = false;

        for (
            const roadId of
            [...this.roadEffects.keys()]
        ) {
            if (
                this.roadEffects
                    .get(roadId)
                    ?.has(effectId)
            ) {
                this.removeRoadEffect(
                    effectId,
                    roadId,
                );
                changed = true;
            }
        }

        return changed;
    }

    roadCostMultiplier(
        roadOrId,
        runtime = null,
    ) {
        const road =
            typeof roadOrId === "string"
                ? this.roads.get(
                    roadOrId,
                )
                : roadOrId;

        if (!road) return Infinity;

        let multiplier = 1;
        const effects =
            this.roadEffects.get(
                road.id,
            );

        if (effects) {
            for (
                const effect of
                effects.values()
            ) {
                if (effect.blocked) {
                    return Infinity;
                }

                multiplier *=
                    effect.costMultiplier;
            }
        }

        if (runtime) {
            const runtimeMultiplier =
                runtime.roadCostMultiplier(
                    road,
                );

            if (
                !Number.isFinite(
                    runtimeMultiplier,
                )
            ) {
                return Infinity;
            }

            multiplier *=
                runtimeMultiplier;
        }

        return multiplier;
    }

    roadTraversalDelaySeconds(
        roadOrId,
        runtime = null,
    ) {
        const road =
            typeof roadOrId === "string"
                ? this.roads.get(
                    roadOrId,
                )
                : roadOrId;

        if (!road) return Infinity;

        let delay = 0;
        const effects =
            this.roadEffects.get(
                road.id,
            );

        if (effects) {
            for (
                const effect of
                effects.values()
            ) {
                delay +=
                    effect.traversalDelaySeconds ??
                    0;
            }
        }

        if (
            runtime?.roadTraversalDelaySeconds
        ) {
            const runtimeDelay =
                runtime.roadTraversalDelaySeconds(
                    road,
                );

            if (
                !Number.isFinite(
                    runtimeDelay,
                ) ||
                runtimeDelay < 0
            ) {
                return Infinity;
            }

            delay += runtimeDelay;
        }

        return delay;
    }

    roadTravelSeconds(
        roadOrId,
        mobility,
        runtime = null,
        distanceOverride = null,
    ) {
        const road =
            typeof roadOrId === "string"
                ? this.roads.get(
                    roadOrId,
                )
                : roadOrId;

        if (!road) return Infinity;

        const speed =
            roadSurfaceSpeed(
                road,
                mobility,
            );
        const multiplier =
            this.roadCostMultiplier(
                road,
                runtime,
            );
        const delay =
            this.roadTraversalDelaySeconds(
                road,
                runtime,
            );
        const travelDistance =
            distanceOverride == null
                ? road.length
                : distanceOverride;

        if (
            !(speed > 0) ||
            !Number.isFinite(multiplier) ||
            !Number.isFinite(delay) ||
            !(travelDistance >= 0)
        ) {
            return Infinity;
        }

        return (
            travelDistance /
                speed *
                multiplier +
            delay
        );
    }

    canTraverseRoad(
        roadOrId,
        mobility,
        runtime = null,
    ) {
        const road =
            typeof roadOrId === "string"
                ? this.roads.get(roadOrId)
                : roadOrId;

        if (!road || !road.enabled) {
            return false;
        }

        if (
            !Number.isFinite(
                this.roadCostMultiplier(
                    road,
                    runtime,
                ),
            )
        ) {
            return false;
        }

        if (!(mobility?.speed > 0)) {
            return false;
        }

        if (
            !profileAllowed(
                road,
                mobility,
            ) ||
            !tagsAllowed(
                road,
                mobility,
            )
        ) {
            return false;
        }

        if (
            (mobility.requiredRoadWidth ?? 0) >
            road.width
        ) {
            return false;
        }

        return (
            roadSurfaceSpeed(
                road,
                mobility,
            ) > 0
        );
    }

    isRouteLegCurrent(
        leg,
        mobility,
        runtime = null,
    ) {
        const road =
            this.roads.get(
                leg.roadId,
            );

        return Boolean(
            road &&
            road.version ===
                leg.roadVersion &&
            this.canTraverseRoad(
                road,
                mobility,
                runtime,
            ),
        );
    }

    isRouteCurrent(
        route,
        mobility,
        startLegIndex = 0,
        runtime = null,
    ) {
        for (
            let i = startLegIndex;
            i < route.legs.length;
            i++
        ) {
            if (
                !this.isRouteLegCurrent(
                    route.legs[i],
                    mobility,
                    runtime,
                )
            ) {
                return false;
            }
        }

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

            if (
                d <= tolerance &&
                (
                    d < bestDistance ||
                    (
                        d === bestDistance &&
                        node.id < best.id
                    )
                )
            ) {
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
            const candidates =
                this.nodeIndex.queryRadiusInto(
                    this.nodeQueryScratch,
                    position,
                    radius,
                );

            if (candidates.size > 0) {
                let best = null;

                for (const nodeId of candidates) {
                    const node = this.nodes.get(nodeId);
                    if (!node) continue;

                    const d =
                        distance(position, node.position);

                    if (
                        !best ||
                        d < best.distance ||
                        (
                            d === best.distance &&
                            node.id < best.node.id
                        )
                    ) {
                        best = {
                            node,
                            distance: d,
                        };
                    }
                }

                if (
                    best &&
                    best.distance <= radius
                ) {
                    return best;
                }
            }

            radius *= 2;
        }

        let best = null;

        for (
            const node of
            [...this.nodes.values()]
                .sort((a, b) =>
                    a.id.localeCompare(b.id))
        ) {
            const d = distance(position, node.position);

            if (
                !best ||
                d < best.distance ||
                (
                    d === best.distance &&
                    node.id < best.node.id
                )
            ) {
                best = {
                    node,
                    distance: d,
                };
            }
        }

        return best;
    }

    roadAt(
        position,
        extraTolerance = 0,
        { includeDisabled = true } = {},
    ) {
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

        for (
            const roadId of
            [...candidates].sort()
        ) {
            const road = this.roads.get(roadId);
            if (!road) continue;
            if (!includeDisabled && !road.enabled) {
                continue;
            }

            const closest =
                closestPointOnPolyline(
                    position,
                    road.points,
                );

            if (!closest) continue;

            const allowedDistance =
                road.width / 2 + extraTolerance;

            if (
                closest.distance > allowedDistance
            ) {
                continue;
            }

            if (
                !best ||
                closest.distance < best.distance ||
                (
                    closest.distance === best.distance &&
                    road.id < best.road.id
                )
            ) {
                best = {
                    road,
                    ...closest,
                };
            }
        }

        return best;
    }

    findNavigationEntries(
        position,
        mobility,
        {
            maxDistance = 0,
            maxEntries = 16,
        } = {},
        runtime = null,
    ) {
        if (!(maxDistance >= 0)) {
            throw new Error(
                "maxDistance must be greater than or equal to 0",
            );
        }

        if (!(maxEntries > 0)) return [];

        const candidates = [];

        const nodeIds =
            this.nodeIndex.queryRadiusInto(
                this.nodeQueryScratch,
                position,
                maxDistance,
            );

        for (const nodeId of nodeIds) {
            const node = this.nodes.get(nodeId);
            if (!node) continue;

            const d = distance(
                position,
                node.position,
            );

            if (d > maxDistance) continue;

            candidates.push({
                kind: "node",
                id: node.id,
                node,
                point: node.position,
                distance: d,
            });
        }

        const roadIds =
            this.roadIndex.queryRadiusInto(
                this.roadQueryScratch,
                position,
                maxDistance +
                    this.maxRoadHalfWidth,
            );

        for (const roadId of roadIds) {
            const road = this.roads.get(roadId);

            if (
                !road ||
                !this.canTraverseRoad(
                    road,
                    mobility,
                    runtime,
                )
            ) {
                continue;
            }

            const closest =
                closestPointOnPolyline(
                    position,
                    road.points,
                );

            if (!closest) continue;
            if (closest.distance > maxDistance) {
                continue;
            }

            candidates.push({
                kind: "road",
                id: road.id,
                road,
                ...closest,
            });
        }

        candidates.sort((a, b) => {
            if (a.distance !== b.distance) {
                return a.distance - b.distance;
            }

            if (a.kind !== b.kind) {
                return a.kind === "node" ? -1 : 1;
            }

            return a.id.localeCompare(b.id);
        });

        if (candidates.length > maxEntries) {
            candidates.length = maxEntries;
        }

        return candidates;
    }

    #planFromRoadHit(
        position,
        hit,
        destinationNodeId,
        mobility,
        runtime = null,
    ) {
        const road = hit.road;

        if (
            !this.canTraverseRoad(
                road,
                mobility,
                runtime,
            )
        ) {
            return null;
        }

        const speed =
            roadSurfaceSpeed(road, mobility);

        if (!(speed > 0)) return null;

        const entrySeconds =
            distance(position, hit.point) /
            mobility.speed;

        let best = null;

        const consider = (
            endpointNodeId,
            reversed,
            partialDistance,
        ) => {
            const baseRoute = this.findRoute(
                endpointNodeId,
                destinationNodeId,
                mobility,
                runtime,
            );

            if (!baseRoute) return;

            const partialSeconds =
                this.roadTravelSeconds(
                    road,
                    mobility,
                    runtime,
                    partialDistance,
                );

            const totalSeconds =
                entrySeconds +
                partialSeconds +
                baseRoute.estimatedSeconds;

            const prefixLeg =
                partialDistance > EPSILON
                    ? {
                        roadId: road.id,
                        reversed,
                        roadVersion: road.version,
                        startSegmentIndex:
                            hit.segmentIndex,
                    }
                    : null;

            const candidate = {
                route: baseRoute,
                prefixLeg,
                entryPoint:
                    distance(
                        position,
                        hit.point,
                    ) > EPSILON
                        ? { ...hit.point }
                        : null,
                estimatedSeconds:
                    totalSeconds,
            };

            if (
                !best ||
                totalSeconds <
                    best.estimatedSeconds
            ) {
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

    findRouteCostsToMany(
        startNodeId,
        destinationNodeIds,
        mobility,
        runtime = null,
    ) {
        const start = this.nodes.get(startNodeId);
        if (!start) throw new Error(`Unknown start node: ${startNodeId}`);
        if (!(mobility?.speed > 0)) return new Map();

        const targets = [...new Set(destinationNodeIds ?? [])].sort();
        const targetSet = new Set();
        for (const id of targets) {
            if (!this.nodes.has(id)) throw new Error(`Unknown destination node: ${id}`);
            targetSet.add(id);
        }
        if (targetSet.size === 0) return new Map();

        const remaining = new Set(targetSet);
        const settled = new Map();
        const queue = new MinPriorityQueue();
        const costs = new Map([[startNodeId, 0]]);
        queue.push(startNodeId, 0, startNodeId);

        while (queue.size > 0 && remaining.size > 0) {
            const entry = queue.pop();
            const current = entry.value;
            const currentCost = costs.get(current);
            if (currentCost == null || entry.priority > currentCost + EPSILON) continue;

            if (remaining.delete(current)) {
                settled.set(current, currentCost);
                if (remaining.size === 0) break;
            }

            for (const edge of this.adjacency.get(current) ?? []) {
                const road = this.roads.get(edge.roadId);
                if (!road || !this.canTraverseRoad(road, mobility, runtime)) continue;
                const speed = roadSurfaceSpeed(road, mobility);
                if (!(speed > 0)) continue;
                const nextCost = currentCost +
                    this.roadTravelSeconds(
                        road,
                        mobility,
                        runtime,
                    );
                const known = costs.get(edge.to) ?? Infinity;
                if (nextCost >= known - EPSILON) continue;
                costs.set(edge.to, nextCost);
                queue.push(edge.to, nextCost, edge.to);
            }
        }

        const result = new Map();
        for (const id of targets) {
            const value = settled.get(id);
            if (value != null) result.set(id, value);
        }
        return result;
    }

    findRouteCostsFromPositionToMany(
        position,
        destinationNodeIds,
        mobility,
        {
            nodeTolerance = 0.1,
            roadTolerance = 0,
            entryMaxDistance = 0,
            maxEntryCandidates = 16,
        } = {},
        runtime = null,
    ) {
        const targets = [...new Set(destinationNodeIds ?? [])].sort();
        if (targets.length === 0) return new Map();

        const merge = (targetMap, baseSeconds) => {
            for (const [id, seconds] of targetMap) {
                const total = baseSeconds + seconds;
                const known = result.get(id);
                if (known == null || total < known) result.set(id, total);
            }
        };
        const result = new Map();

        const node = this.nodeAt(position, nodeTolerance);
        if (node) {
            merge(this.findRouteCostsToMany(node.id, targets, mobility, runtime), 0);
            return result;
        }

        const evaluateRoadHit = hit => {
            if (!hit || !this.canTraverseRoad(hit.road, mobility, runtime)) return;
            const road = hit.road;
            const speed = roadSurfaceSpeed(road, mobility);
            if (!(speed > 0)) return;
            const entrySeconds = distance(position, hit.point) / mobility.speed;
            merge(
                this.findRouteCostsToMany(road.to, targets, mobility, runtime),
                entrySeconds +
                    this.roadTravelSeconds(
                        road,
                        mobility,
                        runtime,
                        road.length - hit.distanceAlong,
                    ),
            );
            if (road.bidirectional) {
                merge(
                    this.findRouteCostsToMany(road.from, targets, mobility, runtime),
                    entrySeconds +
                        this.roadTravelSeconds(
                            road,
                            mobility,
                            runtime,
                            hit.distanceAlong,
                        ),
                );
            }
        };

        const hit = this.roadAt(position, roadTolerance, { includeDisabled: false });
        if (hit) {
            evaluateRoadHit(hit);
            if (result.size > 0) return result;
        }

        if (!(entryMaxDistance > 0)) return result;
        for (const entry of this.findNavigationEntries(
            position,
            mobility,
            { maxDistance: entryMaxDistance, maxEntries: maxEntryCandidates },
            runtime,
        )) {
            if (entry.kind === "node") {
                merge(
                    this.findRouteCostsToMany(entry.node.id, targets, mobility, runtime),
                    entry.distance / mobility.speed,
                );
            } else {
                evaluateRoadHit(entry);
            }
        }

        return result;
    }

    findRouteToAny(
        startNodeId,
        destinationNodeIds,
        mobility,
        runtime = null,
    ) {
        const start = this.nodes.get(startNodeId);
        if (!start) throw new Error(`Unknown start node: ${startNodeId}`);
        if (!(mobility?.speed > 0)) return null;

        const targets = [...new Set(destinationNodeIds ?? [])].sort();
        if (targets.length === 0) return null;
        for (const id of targets) {
            if (!this.nodes.has(id)) throw new Error(`Unknown destination node: ${id}`);
        }
        const targetSet = new Set(targets);
        if (targetSet.has(startNodeId)) {
            return { startNodeId, destinationNodeId: startNodeId, legs: [], estimatedSeconds: 0 };
        }

        const queue = new MinPriorityQueue();
        const costs = new Map([[startNodeId, 0]]);
        const previous = new Map();
        queue.push(startNodeId, 0, startNodeId);
        let destinationNodeId = null;

        while (queue.size > 0) {
            const entry = queue.pop();
            const current = entry.value;
            const currentCost = costs.get(current);
            if (currentCost == null || entry.priority > currentCost + EPSILON) continue;
            if (targetSet.has(current)) {
                destinationNodeId = current;
                break;
            }

            for (const edge of this.adjacency.get(current) ?? []) {
                const road = this.roads.get(edge.roadId);
                if (!road || !this.canTraverseRoad(road, mobility, runtime)) continue;
                const speed = roadSurfaceSpeed(road, mobility);
                const nextCost = currentCost +
                    this.roadTravelSeconds(
                        road,
                        mobility,
                        runtime,
                    );
                const known = costs.get(edge.to) ?? Infinity;
                const prev = previous.get(edge.to);
                const lexical = Math.abs(nextCost-known) <= EPSILON &&
                    (!prev || road.id < prev.roadId);
                if (nextCost > known + EPSILON ||
                    (Math.abs(nextCost-known) <= EPSILON && !lexical)) continue;
                costs.set(edge.to, nextCost);
                previous.set(edge.to, {
                    previousNode: current,
                    roadId: edge.roadId,
                    reversed: edge.reversed,
                    roadVersion: road.version,
                });
                queue.push(edge.to, nextCost, edge.to);
            }
        }

        if (destinationNodeId == null) return null;
        const legs = [];
        let nodeId = destinationNodeId;
        while (nodeId !== startNodeId) {
            const step = previous.get(nodeId);
            if (!step) return null;
            legs.push({
                roadId: step.roadId,
                reversed: step.reversed,
                roadVersion: step.roadVersion,
            });
            nodeId = step.previousNode;
        }
        legs.reverse();
        return {
            startNodeId,
            destinationNodeId,
            legs,
            estimatedSeconds: costs.get(destinationNodeId),
        };
    }

    findRouteFromPositionToAny(
        position,
        destinationNodeIds,
        mobility,
        {
            nodeTolerance = 0.1,
            roadTolerance = 0,
            entryMaxDistance = 0,
            maxEntryCandidates = 16,
        } = {},
        runtime = null,
    ) {
        const targets = [...new Set(destinationNodeIds ?? [])].sort();
        if (targets.length === 0) return null;

        const fromNode = this.nodeAt(position, nodeTolerance);
        if (fromNode) {
            const route = this.findRouteToAny(fromNode.id, targets, mobility, runtime);
            if (route) return {
                route,
                prefixLeg: null,
                entryPoint: null,
                estimatedSeconds: route.estimatedSeconds,
            };
        }

        const considerRoadHit = hit => {
            if (!hit || !this.canTraverseRoad(hit.road, mobility, runtime)) return null;
            const road = hit.road;
            const speed = roadSurfaceSpeed(road, mobility);
            if (!(speed > 0)) return null;
            const entrySeconds = distance(position, hit.point) / mobility.speed;
            let best = null;
            const consider = (endpointNodeId, reversed, partialDistance) => {
                const route = this.findRouteToAny(endpointNodeId, targets, mobility, runtime);
                if (!route) return;
                const partialSeconds =
                    this.roadTravelSeconds(
                        road,
                        mobility,
                        runtime,
                        partialDistance,
                    );
                const total = entrySeconds + partialSeconds + route.estimatedSeconds;
                const candidate = {
                    route,
                    prefixLeg: partialDistance > EPSILON ? {
                        roadId: road.id,
                        reversed,
                        roadVersion: road.version,
                        startSegmentIndex: hit.segmentIndex,
                    } : null,
                    entryPoint: distance(position, hit.point) > EPSILON ? { ...hit.point } : null,
                    estimatedSeconds: total,
                };
                if (!best || total < best.estimatedSeconds ||
                    (total === best.estimatedSeconds &&
                     route.destinationNodeId < best.route.destinationNodeId)) best = candidate;
            };
            consider(road.to, false, road.length - hit.distanceAlong);
            if (road.bidirectional) consider(road.from, true, hit.distanceAlong);
            return best;
        };

        const hit = this.roadAt(position, roadTolerance, { includeDisabled: false });
        const direct = considerRoadHit(hit);
        if (direct) return direct;
        if (!(entryMaxDistance > 0)) return null;

        let best = null;
        for (const entry of this.findNavigationEntries(
            position, mobility,
            { maxDistance: entryMaxDistance, maxEntries: maxEntryCandidates },
            runtime,
        )) {
            let candidate = null;
            if (entry.kind === "node") {
                const route = this.findRouteToAny(entry.node.id, targets, mobility, runtime);
                if (route) candidate = {
                    route,
                    prefixLeg: null,
                    entryPoint: entry.distance > EPSILON ? { ...entry.node.position } : null,
                    estimatedSeconds: entry.distance / mobility.speed + route.estimatedSeconds,
                };
            } else {
                candidate = considerRoadHit(entry);
            }
            if (candidate && (!best ||
                candidate.estimatedSeconds < best.estimatedSeconds ||
                (candidate.estimatedSeconds === best.estimatedSeconds &&
                 candidate.route.destinationNodeId < best.route.destinationNodeId))) best = candidate;
        }
        return best;
    }

    findRouteFromPosition(
        position,
        destinationNodeId,
        mobility,
        {
            nodeTolerance = 0.1,
            roadTolerance = 0,
            entryMaxDistance = 0,
            maxEntryCandidates = 16,
        } = {},
        runtime = null,
    ) {
        const node = this.nodeAt(
            position,
            nodeTolerance,
        );

        if (node) {
            const route = this.findRoute(
                node.id,
                destinationNodeId,
                mobility,
                runtime,
            );

            if (route) {
                return {
                    route,
                    prefixLeg: null,
                    entryPoint: null,
                    estimatedSeconds:
                        route.estimatedSeconds,
                };
            }
        }

        const hit = this.roadAt(
            position,
            roadTolerance,
            { includeDisabled: false },
        );

        if (
            hit &&
            this.canTraverseRoad(
                hit.road,
                mobility,
                runtime,
            )
        ) {
            const planned =
                this.#planFromRoadHit(
                    position,
                    hit,
                    destinationNodeId,
                    mobility,
                    runtime,
                );

            if (planned) return planned;
        }

        if (!(entryMaxDistance > 0)) {
            return null;
        }

        const entries =
            this.findNavigationEntries(
                position,
                mobility,
                {
                    maxDistance:
                        entryMaxDistance,
                    maxEntries:
                        maxEntryCandidates,
                },
                runtime,
            );

        let best = null;

        for (const entry of entries) {
            let candidate = null;

            if (entry.kind === "node") {
                const route = this.findRoute(
                    entry.node.id,
                    destinationNodeId,
                    mobility,
                    runtime,
                );

                if (!route) continue;

                candidate = {
                    route,
                    prefixLeg: null,
                    entryPoint:
                        entry.distance > EPSILON
                            ? {
                                ...entry.node.position,
                            }
                            : null,
                    estimatedSeconds:
                        entry.distance /
                            mobility.speed +
                        route.estimatedSeconds,
                };
            } else {
                candidate =
                    this.#planFromRoadHit(
                        position,
                        entry,
                        destinationNodeId,
                        mobility,
                        runtime,
                    );
            }

            if (
                candidate &&
                (
                    !best ||
                    candidate.estimatedSeconds <
                        best.estimatedSeconds
                )
            ) {
                best = candidate;
            }
        }

        return best;
    }

    getDiagnostics() {
        let adjacencyEdges = 0;

        for (const edges of this.adjacency.values()) {
            adjacencyEdges += edges.length;
        }

        return {
            nodeCount: this.nodes.size,
            roadCount: this.roads.size,
            regionCount:
                this.regions.size,
            regionAssignedNodes:
                [...this.regions.values()]
                    .reduce(
                        (sum, region) =>
                            sum +
                            region.nodeIds.size,
                        0,
                    ),
            regionGatewayCount:
                (() => {
                    this.#refreshRegionGateways();
                    return [
                        ...this.regionGatewayCache.values(),
                    ].reduce(
                        (sum, gateways) =>
                            sum +
                            gateways.size,
                        0,
                    );
                })(),
            hierarchicalRouteCacheSize:
                this.hierarchicalRouteCache.size,
            regionalRouteCacheSize:
                this.regionalRouteCache.size,
            roadEffectRoadCount:
                this.roadEffects.size,
            roadEffectCount:
                [...this.roadEffects.values()]
                    .reduce(
                        (sum, effects) =>
                            sum + effects.size,
                        0,
                    ),
            adjacencyNodeCount: this.adjacency.size,
            adjacencyEdgeCount: adjacencyEdges,
            componentCount: this.componentMembers.size,
            nodeIndexItemCount: this.nodeIndex.itemCells.size,
            nodeIndexMemberships: this.nodeIndex.membershipCount(),
            roadIndexItemCount: this.roadIndex.itemCells.size,
            roadIndexMemberships: this.roadIndex.membershipCount(),
            routeCacheSize: this.routeCache.size,
            routeCacheLegCount: this.routeCacheLegCount,
            graphRevision: this.graphRevision,
            maxRoadHalfWidth: this.maxRoadHalfWidth,
        };
    }

    assertInternalConsistency() {
        const diagnostics = this.getDiagnostics();

        if (
            diagnostics.adjacencyNodeCount !==
            diagnostics.nodeCount
        ) {
            throw new Error(
                `Adjacency node count drift: ${diagnostics.adjacencyNodeCount} adjacency entries for ${diagnostics.nodeCount} nodes`,
            );
        }

        if (
            diagnostics.nodeIndexItemCount !==
            diagnostics.nodeCount
        ) {
            throw new Error(
                `Node index drift: ${diagnostics.nodeIndexItemCount} indexed nodes for ${diagnostics.nodeCount} nodes`,
            );
        }

        if (
            diagnostics.roadIndexItemCount !==
            diagnostics.roadCount
        ) {
            throw new Error(
                `Road index drift: ${diagnostics.roadIndexItemCount} indexed roads for ${diagnostics.roadCount} roads`,
            );
        }

        for (const nodeId of this.nodeIndex.itemCells.keys()) {
            if (!this.nodes.has(nodeId)) {
                throw new Error(
                    `Node index contains stale node: ${nodeId}`,
                );
            }
        }

        for (const roadId of this.roadIndex.itemCells.keys()) {
            if (!this.roads.has(roadId)) {
                throw new Error(
                    `Road index contains stale road: ${roadId}`,
                );
            }
        }

        let expectedMaxRoadHalfWidth = 0;
        let expectedAdjacencyEdges = 0;

        for (const [nodeId, node] of this.nodes) {
            if (
                node.regionId != null &&
                !this.regions.has(
                    node.regionId,
                )
            ) {
                throw new Error(
                    `Node references missing navigation region: ${nodeId}`,
                );
            }

            if (
                node.regionId != null &&
                !this.regions
                    .get(node.regionId)
                    .nodeIds.has(nodeId)
            ) {
                throw new Error(
                    `Region membership mismatch for node: ${nodeId}`,
                );
            }

            if (!(node.junctionRadius >= 0)) {
                throw new Error(
                    `Node has invalid junction radius: ${nodeId}`,
                );
            }

            if (!this.adjacency.has(nodeId)) {
                throw new Error(
                    `Node missing adjacency list: ${nodeId}`,
                );
            }

            if (!this.nodeIndex.itemCells.has(nodeId)) {
                throw new Error(
                    `Node missing from spatial index: ${nodeId}`,
                );
            }

            const members =
                this.componentMembers.get(
                    node.componentId,
                );

            if (!members?.has(nodeId)) {
                throw new Error(
                    `Node component membership mismatch: ${nodeId}`,
                );
            }
        }

        const regionSeen =
            new Set();

        for (
            const [regionId, region] of
            this.regions
        ) {
            if (
                region.id !== regionId
            ) {
                throw new Error(
                    `Navigation region id mismatch: ${regionId}`,
                );
            }

            for (
                const nodeId of
                region.nodeIds
            ) {
                if (
                    regionSeen.has(
                        nodeId,
                    )
                ) {
                    throw new Error(
                        `Node belongs to multiple navigation regions: ${nodeId}`,
                    );
                }

                regionSeen.add(nodeId);

                const node =
                    this.nodes.get(
                        nodeId,
                    );

                if (!node) {
                    throw new Error(
                        `Navigation region contains missing node: ${nodeId}`,
                    );
                }

                if (
                    node.regionId !==
                    regionId
                ) {
                    throw new Error(
                        `Navigation region membership mismatch: ${nodeId}`,
                    );
                }
            }
        }

        for (const [roadId, road] of this.roads) {
            const from = this.nodes.get(road.from);
            const to = this.nodes.get(road.to);

            if (!from || !to) {
                throw new Error(
                    `Road has missing endpoint node: ${roadId}`,
                );
            }

            if (!(road.width > 0)) {
                throw new Error(
                    `Road has invalid width: ${roadId}`,
                );
            }

            if (
                !Number.isFinite(road.length) ||
                road.length < 0
            ) {
                throw new Error(
                    `Road has invalid length: ${roadId}`,
                );
            }

            if (
                !Number.isInteger(road.version) ||
                road.version < 1
            ) {
                throw new Error(
                    `Road has invalid version: ${roadId}`,
                );
            }

            if (
                road.points.length < 2 ||
                road.points[0].x !== from.position.x ||
                road.points[0].y !== from.position.y ||
                road.points.at(-1).x !== to.position.x ||
                road.points.at(-1).y !== to.position.y
            ) {
                throw new Error(
                    `Road geometry endpoint mismatch: ${roadId}`,
                );
            }

            const measuredLength =
                polylineLength(road.points);

            if (
                Math.abs(
                    measuredLength - road.length,
                ) > EPSILON
            ) {
                throw new Error(
                    `Road length mismatch: ${roadId}`,
                );
            }

            if (!this.roadIndex.itemCells.has(roadId)) {
                throw new Error(
                    `Road missing from spatial index: ${roadId}`,
                );
            }

            const forwardMatches =
                (this.adjacency.get(road.from) ?? [])
                    .filter(edge =>
                        edge.roadId === roadId &&
                        edge.to === road.to &&
                        edge.reversed === false
                    ).length;

            if (forwardMatches !== 1) {
                throw new Error(
                    `Road forward adjacency mismatch: ${roadId}`,
                );
            }

            const reverseMatches =
                (this.adjacency.get(road.to) ?? [])
                    .filter(edge =>
                        edge.roadId === roadId &&
                        edge.to === road.from &&
                        edge.reversed === true
                    ).length;

            if (
                reverseMatches !==
                (road.bidirectional ? 1 : 0)
            ) {
                throw new Error(
                    `Road reverse adjacency mismatch: ${roadId}`,
                );
            }

            expectedAdjacencyEdges +=
                road.bidirectional ? 2 : 1;

            expectedMaxRoadHalfWidth =
                Math.max(
                    expectedMaxRoadHalfWidth,
                    road.width / 2,
                );

            if (
                road.enabled &&
                from.componentId !==
                    to.componentId
            ) {
                throw new Error(
                    `Enabled road crosses components: ${roadId}`,
                );
            }
        }

        if (
            diagnostics.adjacencyEdgeCount !==
            expectedAdjacencyEdges
        ) {
            throw new Error(
                `Adjacency edge count drift: ${diagnostics.adjacencyEdgeCount} edges for expected ${expectedAdjacencyEdges}`,
            );
        }

        for (const [nodeId, edges] of this.adjacency) {
            if (!this.nodes.has(nodeId)) {
                throw new Error(
                    `Adjacency contains stale node: ${nodeId}`,
                );
            }

            let previousEdge = null;
            const seen = new Set();

            for (const edge of edges) {
                const road =
                    this.roads.get(edge.roadId);

                if (!road) {
                    throw new Error(
                        `Adjacency references missing road: ${edge.roadId}`,
                    );
                }

                const validForward =
                    !edge.reversed &&
                    road.from === nodeId &&
                    road.to === edge.to;

                const validReverse =
                    edge.reversed &&
                    road.bidirectional &&
                    road.to === nodeId &&
                    road.from === edge.to;

                if (!validForward && !validReverse) {
                    throw new Error(
                        `Adjacency edge does not match road: ${edge.roadId}`,
                    );
                }

                const signature =
                    `${edge.roadId}|${edge.to}|${Number(edge.reversed)}`;

                if (seen.has(signature)) {
                    throw new Error(
                        `Duplicate adjacency edge: ${nodeId} -> ${signature}`,
                    );
                }

                seen.add(signature);

                if (
                    previousEdge &&
                    compareAdjacencyEdges(
                        previousEdge,
                        edge,
                    ) > 0
                ) {
                    throw new Error(
                        `Adjacency order is not deterministic: ${nodeId}`,
                    );
                }

                previousEdge = edge;
            }
        }

        const componentSeen = new Set();
        let componentNodeCount = 0;

        for (
            const [componentId, members] of
            this.componentMembers
        ) {
            if (members.size === 0) {
                throw new Error(
                    `Empty component: ${componentId}`,
                );
            }

            const memberList =
                [...members].sort();

            for (const nodeId of memberList) {
                if (componentSeen.has(nodeId)) {
                    throw new Error(
                        `Node appears in multiple components: ${nodeId}`,
                    );
                }

                componentSeen.add(nodeId);
                componentNodeCount++;

                const node =
                    this.nodes.get(nodeId);

                if (!node) {
                    throw new Error(
                        `Component contains missing node: ${nodeId}`,
                    );
                }

                if (
                    node.componentId !==
                    componentId
                ) {
                    throw new Error(
                        `Component id mismatch for node: ${nodeId}`,
                    );
                }
            }

            const reachable =
                new Set([memberList[0]]);
            const queue = [memberList[0]];

            for (
                let index = 0;
                index < queue.length;
                index++
            ) {
                const current =
                    queue[index];

                for (const road of this.roads.values()) {
                    if (!road.enabled) continue;

                    let neighbor = null;

                    if (road.from === current) {
                        neighbor = road.to;
                    } else if (road.to === current) {
                        neighbor = road.from;
                    }

                    if (
                        neighbor == null ||
                        reachable.has(neighbor)
                    ) {
                        continue;
                    }

                    if (
                        this.nodes.get(neighbor)
                            ?.componentId !==
                        componentId
                    ) {
                        continue;
                    }

                    reachable.add(neighbor);
                    queue.push(neighbor);
                }
            }

            if (
                reachable.size !==
                members.size
            ) {
                throw new Error(
                    `Component is disconnected: ${componentId}`,
                );
            }
        }

        if (
            componentNodeCount !==
            this.nodes.size
        ) {
            throw new Error(
                `Component coverage drift: ${componentNodeCount} component members for ${this.nodes.size} nodes`,
            );
        }

        if (
            Math.abs(
                this.maxRoadHalfWidth -
                expectedMaxRoadHalfWidth,
            ) > EPSILON
        ) {
            throw new Error(
                `maxRoadHalfWidth drift: ${this.maxRoadHalfWidth} vs expected ${expectedMaxRoadHalfWidth}`,
            );
        }

        for (
            const [roadId, effects] of
            this.roadEffects
        ) {
            if (!this.roads.has(roadId)) {
                throw new Error(
                    `Road effects reference missing road: ${roadId}`,
                );
            }

            for (
                const [effectId, effect] of
                effects
            ) {
                if (!effectId) {
                    throw new Error(
                        `Road effect has empty id on road: ${roadId}`,
                    );
                }

                if (
                    !Number.isFinite(
                        effect.costMultiplier,
                    ) ||
                    effect.costMultiplier < 1
                ) {
                    throw new Error(
                        `Road effect has invalid cost multiplier: ${effectId}`,
                    );
                }
            }
        }

        let cachedLegs = 0;

        for (const [key, entry] of this.routeCache) {
            const route = entry.route;
            const start =
                this.nodes.get(
                    route.startNodeId,
                );
            const destination =
                this.nodes.get(
                    route.destinationNodeId,
                );

            if (!start || !destination) {
                throw new Error(
                    `Cached route references missing endpoint: ${key}`,
                );
            }

            if (
                start.componentId !==
                    destination.componentId ||
                entry.componentId !==
                    start.componentId
            ) {
                throw new Error(
                    `Cached route component mismatch: ${key}`,
                );
            }

            for (const leg of route.legs) {
                const road =
                    this.roads.get(
                        leg.roadId,
                    );

                if (!road) {
                    throw new Error(
                        `Cached route references missing road: ${leg.roadId}`,
                    );
                }

                if (
                    road.version !==
                    leg.roadVersion
                ) {
                    throw new Error(
                        `Cached route contains stale road version: ${leg.roadId}`,
                    );
                }
            }

            cachedLegs +=
                route.legs.length;
        }

        if (
            cachedLegs !==
            this.routeCacheLegCount
        ) {
            throw new Error(
                `Route cache leg count drift: ${this.routeCacheLegCount} vs actual ${cachedLegs}`,
            );
        }

        if (
            this.routeCache.size >
            this.routeCacheSize
        ) {
            throw new Error(
                "Route cache exceeds route count bound",
            );
        }

        if (
            this.routeCacheLegCount >
            this.routeCacheMaxTotalLegs
        ) {
            throw new Error(
                "Route cache exceeds leg count bound",
            );
        }

        if (
            this.hierarchicalRouteCache.size >
            this.hierarchicalRouteCacheSize
        ) {
            throw new Error(
                "Hierarchical route cache exceeds route count bound",
            );
        }

        if (
            this.regionalRouteCache.size >
            this.regionalRouteCacheSize
        ) {
            throw new Error(
                "Regional route cache exceeds route count bound",
            );
        }

        return diagnostics;
    }

    #findRouteWithinRegion(
        startNodeId,
        destinationNodeId,
        mobility,
        regionId,
        runtime = null,
    ) {
        const start =
            this.nodes.get(startNodeId);
        const destination =
            this.nodes.get(
                destinationNodeId,
            );

        if (
            !start ||
            !destination ||
            start.regionId !== regionId ||
            destination.regionId !==
                regionId
        ) {
            return null;
        }

        if (startNodeId === destinationNodeId) {
            return {
                startNodeId,
                destinationNodeId,
                legs: [],
                estimatedSeconds: 0,
            };
        }

        const key =
            `${regionId}|${startNodeId}|${destinationNodeId}|${mobilityCacheKey(mobility)}`;

        const cached =
            runtime
                ? null
                : this.regionalRouteCache.get(
                    key,
                );

        if (cached) {
            this.regionalRouteCache.delete(key);
            this.regionalRouteCache.set(
                key,
                cached,
            );
            return cached;
        }

        const fastestPossibleSpeed =
            maxTravelSpeed(mobility);

        if (!(fastestPossibleSpeed > 0)) {
            return null;
        }

        const queue =
            new MinPriorityQueue();
        const costs =
            new Map([[startNodeId, 0]]);
        const previous =
            new Map();

        queue.push(
            startNodeId,
            distance(
                start.position,
                destination.position,
            ) /
                fastestPossibleSpeed,
            startNodeId,
        );

        while (queue.size > 0) {
            const currentEntry =
                queue.pop();
            const current =
                currentEntry.value;
            const currentCost =
                costs.get(current);

            if (currentCost == null) {
                continue;
            }

            if (
                current ===
                destinationNodeId
            ) {
                break;
            }

            const currentNode =
                this.nodes.get(current);

            const expectedPriority =
                currentCost +
                distance(
                    currentNode.position,
                    destination.position,
                ) /
                    fastestPossibleSpeed;

            if (
                currentEntry.priority >
                expectedPriority +
                    EPSILON
            ) {
                continue;
            }

            for (
                const edge of
                this.adjacency.get(
                    current,
                ) ?? []
            ) {
                const nextNode =
                    this.nodes.get(
                        edge.to,
                    );
                const road =
                    this.roads.get(
                        edge.roadId,
                    );

                if (
                    !nextNode ||
                    nextNode.regionId !==
                        regionId ||
                    !road ||
                    !this.canTraverseRoad(
                        road,
                        mobility,
                        runtime,
                    )
                ) {
                    continue;
                }

                const roadFrom =
                    this.nodes.get(
                        road.from,
                    );
                const roadTo =
                    this.nodes.get(
                        road.to,
                    );

                if (
                    roadFrom?.regionId !==
                        regionId ||
                    roadTo?.regionId !==
                        regionId
                ) {
                    continue;
                }

                const speed =
                    roadSurfaceSpeed(
                        road,
                        mobility,
                    );

                const nextCost =
                    currentCost +
                    this.roadTravelSeconds(
                        road,
                        mobility,
                        runtime,
                    );

                const knownCost =
                    costs.get(edge.to) ??
                    Infinity;
                const previousStep =
                    previous.get(edge.to);

                const lexicallyBetter =
                    Math.abs(
                        nextCost -
                            knownCost,
                    ) <= EPSILON &&
                    (
                        !previousStep ||
                        road.id <
                            previousStep.roadId
                    );

                if (
                    nextCost >
                        knownCost +
                            EPSILON ||
                    (
                        Math.abs(
                            nextCost -
                                knownCost,
                        ) <= EPSILON &&
                        !lexicallyBetter
                    )
                ) {
                    continue;
                }

                costs.set(
                    edge.to,
                    nextCost,
                );
                previous.set(
                    edge.to,
                    {
                        previousNode:
                            current,
                        roadId:
                            edge.roadId,
                        reversed:
                            edge.reversed,
                        roadVersion:
                            road.version,
                    },
                );

                const heuristic =
                    distance(
                        nextNode.position,
                        destination.position,
                    ) /
                    fastestPossibleSpeed;

                queue.push(
                    edge.to,
                    nextCost +
                        heuristic,
                    edge.to,
                );
            }
        }

        if (
            !previous.has(
                destinationNodeId,
            )
        ) {
            return null;
        }

        const legs = [];
        let nodeId =
            destinationNodeId;

        while (
            nodeId !== startNodeId
        ) {
            const step =
                previous.get(nodeId);

            if (!step) return null;

            legs.push({
                roadId:
                    step.roadId,
                reversed:
                    step.reversed,
                roadVersion:
                    step.roadVersion,
            });

            nodeId =
                step.previousNode;
        }

        legs.reverse();

        const route = {
            startNodeId,
            destinationNodeId,
            legs,
            estimatedSeconds:
                costs.get(
                    destinationNodeId,
                ),
        };

        if (runtime) {
            return route;
        }

        return this.#setBoundedCache(
            this.regionalRouteCache,
            key,
            route,
            this.regionalRouteCacheSize,
        );
    }

    findHierarchicalRoute(
        startNodeId,
        destinationNodeId,
        mobility,
        runtime = null,
    ) {
        const start =
            this.nodes.get(startNodeId);
        const destination =
            this.nodes.get(
                destinationNodeId,
            );

        if (!start) {
            throw new Error(
                `Unknown start node: ${startNodeId}`,
            );
        }

        if (!destination) {
            throw new Error(
                `Unknown destination node: ${destinationNodeId}`,
            );
        }

        if (
            start.regionId == null ||
            destination.regionId == null ||
            start.regionId ===
                destination.regionId
        ) {
            return this.findRoute(
                startNodeId,
                destinationNodeId,
                mobility,
                runtime,
            );
        }

        if (
            start.componentId !==
            destination.componentId
        ) {
            return null;
        }

        this.#refreshRegionGateways();

        const cacheKey =
            `${startNodeId}|${destinationNodeId}|${mobilityCacheKey(mobility)}`;
        const cached =
            runtime
                ? null
                : this.hierarchicalRouteCache
                    .get(cacheKey);

        if (cached) {
            this.hierarchicalRouteCache
                .delete(cacheKey);
            this.hierarchicalRouteCache
                .set(
                    cacheKey,
                    cached,
                );
            return cached;
        }

        const fastestPossibleSpeed =
            maxTravelSpeed(mobility);

        if (!(fastestPossibleSpeed > 0)) {
            return null;
        }

        const queue =
            new MinPriorityQueue();
        const costs =
            new Map([[startNodeId, 0]]);
        const previous =
            new Map();

        queue.push(
            startNodeId,
            distance(
                start.position,
                destination.position,
            ) /
                fastestPossibleSpeed,
            startNodeId,
        );

        while (queue.size > 0) {
            const currentEntry =
                queue.pop();
            const currentId =
                currentEntry.value;
            const currentCost =
                costs.get(currentId);

            if (currentCost == null) {
                continue;
            }

            if (
                currentId ===
                destinationNodeId
            ) {
                break;
            }

            const currentNode =
                this.nodes.get(
                    currentId,
                );

            const expectedPriority =
                currentCost +
                distance(
                    currentNode.position,
                    destination.position,
                ) /
                    fastestPossibleSpeed;

            if (
                currentEntry.priority >
                expectedPriority +
                    EPSILON
            ) {
                continue;
            }

            const localTargets =
                new Set(
                    this.regionGatewayCache
                        .get(
                            currentNode.regionId,
                        ) ?? [],
                );

            if (
                destination.regionId ===
                currentNode.regionId
            ) {
                localTargets.add(
                    destinationNodeId,
                );
            }

            for (
                const targetId of
                [...localTargets].sort()
            ) {
                if (
                    targetId ===
                    currentId
                ) {
                    continue;
                }

                const localRoute =
                    this.#findRouteWithinRegion(
                        currentId,
                        targetId,
                        mobility,
                        currentNode.regionId,
                        runtime,
                    );

                if (!localRoute) {
                    continue;
                }

                const nextCost =
                    currentCost +
                    localRoute.estimatedSeconds;
                const knownCost =
                    costs.get(targetId) ??
                    Infinity;

                if (
                    nextCost >=
                    knownCost -
                        EPSILON
                ) {
                    continue;
                }

                costs.set(
                    targetId,
                    nextCost,
                );
                previous.set(
                    targetId,
                    {
                        previousNode:
                            currentId,
                        type: "local",
                        route:
                            localRoute,
                    },
                );

                const targetNode =
                    this.nodes.get(
                        targetId,
                    );
                const heuristic =
                    distance(
                        targetNode.position,
                        destination.position,
                    ) /
                    fastestPossibleSpeed;

                queue.push(
                    targetId,
                    nextCost +
                        heuristic,
                    targetId,
                );
            }

            for (
                const edge of
                this.adjacency.get(
                    currentId,
                ) ?? []
            ) {
                const nextNode =
                    this.nodes.get(
                        edge.to,
                    );
                const road =
                    this.roads.get(
                        edge.roadId,
                    );

                if (
                    !nextNode ||
                    currentNode.regionId ==
                        null ||
                    nextNode.regionId ==
                        null ||
                    currentNode.regionId ===
                        nextNode.regionId ||
                    !road ||
                    !this.canTraverseRoad(
                        road,
                        mobility,
                        runtime,
                    )
                ) {
                    continue;
                }

                const speed =
                    roadSurfaceSpeed(
                        road,
                        mobility,
                    );
                const segmentCost =
                    this.roadTravelSeconds(
                        road,
                        mobility,
                        runtime,
                    );
                const nextCost =
                    currentCost +
                    segmentCost;
                const knownCost =
                    costs.get(edge.to) ??
                    Infinity;

                if (
                    nextCost >=
                    knownCost -
                        EPSILON
                ) {
                    continue;
                }

                costs.set(
                    edge.to,
                    nextCost,
                );
                previous.set(
                    edge.to,
                    {
                        previousNode:
                            currentId,
                        type: "cross",
                        leg: {
                            roadId:
                                road.id,
                            reversed:
                                edge.reversed,
                            roadVersion:
                                road.version,
                        },
                    },
                );

                const heuristic =
                    distance(
                        nextNode.position,
                        destination.position,
                    ) /
                    fastestPossibleSpeed;

                queue.push(
                    edge.to,
                    nextCost +
                        heuristic,
                    edge.to,
                );
            }
        }

        if (
            !previous.has(
                destinationNodeId,
            )
        ) {
            return null;
        }

        const segments = [];
        let nodeId =
            destinationNodeId;

        while (
            nodeId !== startNodeId
        ) {
            const step =
                previous.get(nodeId);

            if (!step) return null;

            segments.push(step);
            nodeId =
                step.previousNode;
        }

        segments.reverse();

        const legs = [];

        for (const segment of segments) {
            if (
                segment.type ===
                "local"
            ) {
                for (
                    const leg of
                    segment.route.legs
                ) {
                    legs.push({
                        ...leg,
                    });
                }
            } else {
                legs.push({
                    ...segment.leg,
                });
            }
        }

        const route = {
            startNodeId,
            destinationNodeId,
            legs,
            estimatedSeconds:
                costs.get(
                    destinationNodeId,
                ),
        };

        if (runtime) {
            return route;
        }

        return this.#setBoundedCache(
            this.hierarchicalRouteCache,
            cacheKey,
            route,
            this.hierarchicalRouteCacheSize,
        );
    }

    findRoute(
        startNodeId,
        destinationNodeId,
        mobility,
        runtime = null,
    ) {
        const start =
            this.nodes.get(startNodeId);
        const destination =
            this.nodes.get(destinationNodeId);

        if (!start) {
            throw new Error(
                `Unknown start node: ${startNodeId}`,
            );
        }

        if (!destination) {
            throw new Error(
                `Unknown destination node: ${destinationNodeId}`,
            );
        }

        if (!(mobility?.speed > 0)) return null;

        if (
            start.componentId !==
            destination.componentId
        ) {
            return null;
        }

        if (startNodeId === destinationNodeId) {
            return {
                startNodeId,
                destinationNodeId,
                legs: [],
                estimatedSeconds: 0,
            };
        }

        const cacheKey =
            `${startNodeId}|` +
            `${destinationNodeId}|` +
            mobilityCacheKey(mobility);

        const cached =
            runtime
                ? null
                : this.routeCache.get(
                    cacheKey,
                );

        if (cached) {
            this.routeCache.delete(cacheKey);
            this.routeCache.set(cacheKey, cached);
            return cached.route;
        }

        const fastestPossibleSpeed =
            maxTravelSpeed(mobility);

        if (!(fastestPossibleSpeed > 0)) {
            return null;
        }

        const queue = new MinPriorityQueue();
        const costs =
            new Map([[startNodeId, 0]]);
        const previous = new Map();

        queue.push(
            startNodeId,
            distance(
                start.position,
                destination.position,
            ) / fastestPossibleSpeed,
            startNodeId,
        );

        while (queue.size > 0) {
            const currentEntry = queue.pop();
            const current = currentEntry.value;
            const currentCost =
                costs.get(current);

            if (currentCost == null) continue;
            if (current === destinationNodeId) {
                break;
            }

            const currentNode =
                this.nodes.get(current);

            const expectedPriority =
                currentCost +
                distance(
                    currentNode.position,
                    destination.position,
                ) / fastestPossibleSpeed;

            if (
                currentEntry.priority >
                expectedPriority + EPSILON
            ) {
                continue;
            }

            for (
                const edge of
                this.adjacency.get(current) ?? []
            ) {
                const road =
                    this.roads.get(edge.roadId);

                if (
                    !road ||
                    !this.canTraverseRoad(
                        road,
                        mobility,
                        runtime,
                    )
                ) {
                    continue;
                }

                const speed =
                    roadSurfaceSpeed(
                        road,
                        mobility,
                    );

                const nextCost =
                    currentCost +
                    this.roadTravelSeconds(
                        road,
                        mobility,
                        runtime,
                    );

                const knownCost =
                    costs.get(edge.to) ?? Infinity;

                const previousStep =
                    previous.get(edge.to);

                const lexicallyBetter =
                    Math.abs(
                        nextCost - knownCost,
                    ) <= EPSILON &&
                    (
                        !previousStep ||
                        road.id <
                            previousStep.roadId
                    );

                if (
                    nextCost >
                        knownCost + EPSILON ||
                    (
                        Math.abs(
                            nextCost -
                            knownCost,
                        ) <= EPSILON &&
                        !lexicallyBetter
                    )
                ) {
                    continue;
                }

                costs.set(edge.to, nextCost);
                previous.set(edge.to, {
                    previousNode: current,
                    roadId: edge.roadId,
                    reversed: edge.reversed,
                    roadVersion: road.version,
                });

                const nextNode =
                    this.nodes.get(edge.to);

                const heuristic =
                    distance(
                        nextNode.position,
                        destination.position,
                    ) / fastestPossibleSpeed;

                queue.push(
                    edge.to,
                    nextCost + heuristic,
                    edge.to,
                );
            }
        }

        if (
            !previous.has(destinationNodeId)
        ) {
            return null;
        }

        const legs = [];
        let nodeId = destinationNodeId;

        while (nodeId !== startNodeId) {
            const step = previous.get(nodeId);
            if (!step) return null;

            legs.push({
                roadId: step.roadId,
                reversed: step.reversed,
                roadVersion:
                    step.roadVersion,
            });

            nodeId = step.previousNode;
        }

        legs.reverse();

        const route = {
            startNodeId,
            destinationNodeId,
            legs,
            estimatedSeconds:
                costs.get(destinationNodeId),
        };

        if (!runtime) {
            this.#cacheRoute(
                cacheKey,
                route,
                start.componentId,
            );
        }

        return route;
    }
}
