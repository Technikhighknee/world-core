import {
    DEFAULT_WORLD_DOMAIN_ID,
} from "./world.js";

function requireId(id, label) {
    if (
        typeof id !== "string" ||
        id.length === 0
    ) {
        throw new Error(
            `${label} must be a non-empty string`,
        );
    }
}

function requireRoadEffect(
    effect,
) {
    const blocked =
        Boolean(
            effect?.blocked ??
            false,
        );
    const costMultiplier =
        effect?.costMultiplier ??
        1;
    const traversalDelaySeconds =
        effect?.traversalDelaySeconds ??
        0;

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

    return {
        blocked,
        costMultiplier,
        traversalDelaySeconds,
    };
}

/**
 * Sparse mutable road state for one domain over a shared Navigation topology.
 *
 * The topology owns nodes, roads, geometry and static indexes. An instance only
 * exists once a domain needs an override, so the common case (thousands of
 * identical interiors) allocates no per-domain routing object.
 */
export class NavigationInstance {
    constructor(
        domainId,
        topologyId,
        topology,
    ) {
        this.domainId = domainId;
        this.topologyId = topologyId;
        this.topology = topology;
        this.roadEffects = new Map();
        this.revision = 0;
        this.routeRevisions =
            new WeakMap();

        this.runtimePolicy = {
            roadCostMultiplier:
                road =>
                    this.#overlayRoadCostMultiplier(
                        road,
                    ),
            roadTraversalDelaySeconds:
                road =>
                    this.#overlayRoadTraversalDelaySeconds(
                        road,
                    ),
        };
    }

    get nodes() {
        return this.topology.nodes;
    }

    get roads() {
        return this.topology.roads;
    }

    get graphRevision() {
        return (
            `${this.topology.graphRevision}:` +
            `${this.revision}`
        );
    }

    get overrideRoadCount() {
        return this.roadEffects.size;
    }

    get overrideEffectCount() {
        let count = 0;

        for (
            const effects of
            this.roadEffects.values()
        ) {
            count += effects.size;
        }

        return count;
    }

    #overlayRoadCostMultiplier(
        road,
    ) {
        const effects =
            this.roadEffects.get(
                road.id,
            );

        if (!effects) {
            return 1;
        }

        let multiplier = 1;

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

        return multiplier;
    }

    #overlayRoadTraversalDelaySeconds(
        road,
    ) {
        const effects =
            this.roadEffects.get(
                road.id,
            );

        if (!effects) {
            return 0;
        }

        let delay = 0;

        for (
            const effect of
            effects.values()
        ) {
            delay +=
                effect.traversalDelaySeconds;
        }

        return delay;
    }

    #touch() {
        this.revision++;
    }

    #rememberRoute(route) {
        if (route) {
            this.routeRevisions.set(
                route,
                this.revision,
            );
        }

        return route;
    }

    adoptRoute(route) {
        return this.#rememberRoute(
            route,
        );
    }

    setRoadEffect(
        effectId,
        roadId,
        effect = {},
    ) {
        requireId(
            effectId,
            "Road effect id",
        );

        if (
            !this.topology.roads.has(
                roadId,
            )
        ) {
            throw new Error(
                `Unknown road: ${roadId}`,
            );
        }

        const next =
            requireRoadEffect(
                effect,
            );
        let effects =
            this.roadEffects.get(
                roadId,
            );
        const previous =
            effects?.get(effectId);

        if (
            !next.blocked &&
            next.costMultiplier === 1 &&
            next.traversalDelaySeconds === 0
        ) {
            if (!previous) {
                return false;
            }

            effects.delete(effectId);

            if (effects.size === 0) {
                this.roadEffects.delete(
                    roadId,
                );
            }

            this.#touch();
            return true;
        }

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

        if (!effects) {
            effects = new Map();
            this.roadEffects.set(
                roadId,
                effects,
            );
        }

        effects.set(
            effectId,
            next,
        );
        this.#touch();
        return true;
    }

    removeRoadEffect(
        effectId,
        roadId,
    ) {
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

        effects.delete(effectId);

        if (effects.size === 0) {
            this.roadEffects.delete(
                roadId,
            );
        }

        this.#touch();
        return true;
    }

    clearRoadEffect(effectId) {
        let changed = false;

        for (
            const roadId of
            [...this.roadEffects.keys()]
        ) {
            const effects =
                this.roadEffects.get(
                    roadId,
                );

            if (
                !effects?.delete(
                    effectId,
                )
            ) {
                continue;
            }

            changed = true;

            if (effects.size === 0) {
                this.roadEffects.delete(
                    roadId,
                );
            }
        }

        if (changed) {
            this.#touch();
        }

        return changed;
    }

    roadCostMultiplier(
        roadOrId,
    ) {
        return this.topology
            .roadCostMultiplier(
                roadOrId,
                this.runtimePolicy,
            );
    }

    roadTraversalDelaySeconds(
        roadOrId,
    ) {
        return this.topology
            .roadTraversalDelaySeconds(
                roadOrId,
                this.runtimePolicy,
            );
    }

    roadTravelSeconds(
        roadOrId,
        mobility,
        distanceOverride = null,
    ) {
        return this.topology
            .roadTravelSeconds(
                roadOrId,
                mobility,
                this.runtimePolicy,
                distanceOverride,
            );
    }

    canTraverseRoad(
        roadOrId,
        mobility,
    ) {
        return this.topology
            .canTraverseRoad(
                roadOrId,
                mobility,
                this.runtimePolicy,
            );
    }

    isRouteLegCurrent(
        leg,
        mobility,
    ) {
        return this.topology
            .isRouteLegCurrent(
                leg,
                mobility,
                this.runtimePolicy,
            );
    }

    isRouteCurrent(
        route,
        mobility,
        startLegIndex = 0,
    ) {
        if (
            this.routeRevisions.get(
                route,
            ) !== this.revision
        ) {
            return false;
        }

        return this.topology
            .isRouteCurrent(
                route,
                mobility,
                startLegIndex,
                this.runtimePolicy,
            );
    }

    nodeAt(...args) {
        return this.topology.nodeAt(
            ...args,
        );
    }

    nearestNode(...args) {
        return this.topology
            .nearestNode(...args);
    }

    nearestNodeWithDistance(
        ...args
    ) {
        return this.topology
            .nearestNodeWithDistance(
                ...args,
            );
    }

    roadAt(...args) {
        return this.topology.roadAt(
            ...args,
        );
    }

    findNavigationEntries(
        position,
        mobility,
        options = {},
    ) {
        return this.topology
            .findNavigationEntries(
                position,
                mobility,
                options,
                this.runtimePolicy,
            );
    }

    findRouteCostsFromPositionToMany(
        position,
        destinationNodeIds,
        mobility,
        options = {},
    ) {
        return this.topology
            .findRouteCostsFromPositionToMany(
                position,
                destinationNodeIds,
                mobility,
                options,
                this.runtimePolicy,
            );
    }

    findRouteCostsToMany(
        startNodeId,
        destinationNodeIds,
        mobility,
    ) {
        return this.topology
            .findRouteCostsToMany(
                startNodeId,
                destinationNodeIds,
                mobility,
                this.runtimePolicy,
            );
    }

    findRouteFromPositionToAny(
        position,
        destinationNodeIds,
        mobility,
        options = {},
    ) {
        const planned =
            this.topology
                .findRouteFromPositionToAny(
                    position,
                    destinationNodeIds,
                    mobility,
                    options,
                    this.runtimePolicy,
                );

        if (planned?.route) {
            this.#rememberRoute(
                planned.route,
            );
        }

        return planned;
    }

    findRouteToAny(
        startNodeId,
        destinationNodeIds,
        mobility,
    ) {
        return this.#rememberRoute(
            this.topology.findRouteToAny(
                startNodeId,
                destinationNodeIds,
                mobility,
                this.runtimePolicy,
            ),
        );
    }

    findRouteFromPosition(
        position,
        destinationNodeId,
        mobility,
        options = {},
    ) {
        const planned =
            this.topology
                .findRouteFromPosition(
                    position,
                    destinationNodeId,
                    mobility,
                    options,
                    this.runtimePolicy,
                );

        if (planned?.route) {
            this.#rememberRoute(
                planned.route,
            );
        }

        return planned;
    }

    findHierarchicalRoute(
        startNodeId,
        destinationNodeId,
        mobility,
    ) {
        return this.#rememberRoute(
            this.topology
                .findHierarchicalRoute(
                    startNodeId,
                    destinationNodeId,
                    mobility,
                    this.runtimePolicy,
                ),
        );
    }

    findRoute(
        startNodeId,
        destinationNodeId,
        mobility,
    ) {
        return this.#rememberRoute(
            this.topology.findRoute(
                startNodeId,
                destinationNodeId,
                mobility,
                this.runtimePolicy,
            ),
        );
    }

    getDiagnostics() {
        return {
            domainId:
                this.domainId,
            topologyId:
                this.topologyId,
            revision:
                this.revision,
            overrideRoadCount:
                this.overrideRoadCount,
            overrideEffectCount:
                this.overrideEffectCount,
        };
    }

    assertInternalConsistency() {
        if (
            !this.topology ||
            !this.topology.nodes ||
            !this.topology.roads
        ) {
            throw new Error(
                `Navigation instance has invalid topology: ${this.domainId}`,
            );
        }

        for (
            const [
                roadId,
                effects,
            ] of this.roadEffects
        ) {
            if (
                !this.topology.roads.has(
                    roadId,
                )
            ) {
                throw new Error(
                    `Navigation instance references missing road: ${roadId}`,
                );
            }

            if (effects.size === 0) {
                throw new Error(
                    `Navigation instance retains empty road effect set: ${roadId}`,
                );
            }

            for (
                const [
                    effectId,
                    effect,
                ] of effects
            ) {
                requireId(
                    effectId,
                    "Road effect id",
                );
                requireRoadEffect(
                    effect,
                );
            }
        }

        return this.getDiagnostics();
    }
}

/**
 * Binds many world domains to a small set of shared Navigation topologies.
 *
 * Domains without overrides resolve directly to the shared Navigation object.
 * A NavigationInstance is created lazily only when one domain needs mutable
 * road state such as a blocked doorway.
 */
export class NavigationRegistry {
    constructor({
        defaultTopologyId = null,
    } = {}) {
        this.topologies = new Map();
        this.domainBindings =
            new Map();
        this.domainInstances =
            new Map();
        this.defaultTopologyId =
            defaultTopologyId;
    }

    registerTopology(
        id,
        navigation,
    ) {
        requireId(
            id,
            "Navigation topology id",
        );

        if (
            !navigation ||
            typeof navigation
                .findRouteFromPosition !==
                "function" ||
            !navigation.nodes ||
            !navigation.roads
        ) {
            throw new Error(
                "Navigation topology must be a Navigation-compatible object",
            );
        }

        if (this.topologies.has(id)) {
            throw new Error(
                `Navigation topology already exists: ${id}`,
            );
        }

        this.topologies.set(
            id,
            navigation,
        );

        return navigation;
    }

    removeTopology(id) {
        if (!this.topologies.has(id)) {
            return false;
        }

        for (
            const topologyId of
            this.domainBindings.values()
        ) {
            if (topologyId === id) {
                throw new Error(
                    `Cannot remove bound navigation topology: ${id}`,
                );
            }
        }

        if (
            this.defaultTopologyId ===
            id
        ) {
            throw new Error(
                `Cannot remove default navigation topology: ${id}`,
            );
        }

        return this.topologies.delete(
            id,
        );
    }

    setDefaultTopology(id) {
        requireId(
            id,
            "Navigation topology id",
        );

        if (!this.topologies.has(id)) {
            throw new Error(
                `Unknown navigation topology: ${id}`,
            );
        }

        this.defaultTopologyId = id;
    }

    bindDomain(
        domainId,
        topologyId,
    ) {
        requireId(
            domainId,
            "World domain id",
        );
        requireId(
            topologyId,
            "Navigation topology id",
        );

        if (
            !this.topologies.has(
                topologyId,
            )
        ) {
            throw new Error(
                `Unknown navigation topology: ${topologyId}`,
            );
        }

        const previous =
            this.domainBindings.get(
                domainId,
            );

        if (
            previous != null &&
            previous !== topologyId
        ) {
            this.domainInstances.delete(
                domainId,
            );
        }

        this.domainBindings.set(
            domainId,
            topologyId,
        );

        return this.topologies.get(
            topologyId,
        );
    }

    unbindDomain(domainId) {
        this.domainInstances.delete(
            domainId,
        );

        return this.domainBindings.delete(
            domainId,
        );
    }

    topologyIdForDomain(
        domainId =
            DEFAULT_WORLD_DOMAIN_ID,
    ) {
        return (
            this.domainBindings.get(
                domainId,
            ) ??
            this.defaultTopologyId
        );
    }

    #topologyForDomain(
        domainId,
    ) {
        const topologyId =
            this.topologyIdForDomain(
                domainId,
            );

        if (topologyId == null) {
            return null;
        }

        const topology =
            this.topologies.get(
                topologyId,
            );

        if (!topology) {
            return null;
        }

        return {
            topologyId,
            topology,
        };
    }

    #requireExplicitBinding(
        domainId,
    ) {
        const topologyId =
            this.domainBindings.get(
                domainId,
            );

        if (topologyId == null) {
            throw new Error(
                `World domain must be explicitly bound before adding navigation overrides: ${domainId}`,
            );
        }

        const topology =
            this.topologies.get(
                topologyId,
            );

        if (!topology) {
            throw new Error(
                `World domain ${domainId} references missing navigation topology: ${topologyId}`,
            );
        }

        return {
            topologyId,
            topology,
        };
    }

    #instanceForDomain(
        domainId,
        create = false,
    ) {
        let instance =
            this.domainInstances.get(
                domainId,
            );

        if (instance || !create) {
            return instance ?? null;
        }

        const {
            topologyId,
            topology,
        } = this.#requireExplicitBinding(
            domainId,
        );

        instance =
            new NavigationInstance(
                domainId,
                topologyId,
                topology,
            );

        this.domainInstances.set(
            domainId,
            instance,
        );

        return instance;
    }

    setDomainRoadEffect(
        domainId,
        effectId,
        roadId,
        effect = {},
    ) {
        const instance =
            this.#instanceForDomain(
                domainId,
                true,
            );

        instance.setRoadEffect(
            effectId,
            roadId,
            effect,
        );

        if (
            instance.overrideEffectCount ===
                0
        ) {
            this.domainInstances.delete(
                domainId,
            );
            return null;
        }

        return instance;
    }

    removeDomainRoadEffect(
        domainId,
        effectId,
        roadId,
    ) {
        const instance =
            this.#instanceForDomain(
                domainId,
                false,
            );

        if (!instance) {
            return false;
        }

        const changed =
            instance.removeRoadEffect(
                effectId,
                roadId,
            );

        if (
            changed &&
            instance.overrideEffectCount ===
                0
        ) {
            this.domainInstances.delete(
                domainId,
            );
        }

        return changed;
    }

    clearDomainRoadEffect(
        domainId,
        effectId,
    ) {
        const instance =
            this.#instanceForDomain(
                domainId,
                false,
            );

        if (!instance) {
            return false;
        }

        const changed =
            instance.clearRoadEffect(
                effectId,
            );

        if (
            changed &&
            instance.overrideEffectCount ===
                0
        ) {
            this.domainInstances.delete(
                domainId,
            );
        }

        return changed;
    }

    clearDomainOverrides(
        domainId,
    ) {
        return this.domainInstances.delete(
            domainId,
        );
    }

    navigationForDomain(
        domainId =
            DEFAULT_WORLD_DOMAIN_ID,
    ) {
        const instance =
            this.domainInstances.get(
                domainId,
            );

        if (instance) {
            return instance;
        }

        const resolved =
            this.#topologyForDomain(
                domainId,
            );

        return resolved?.topology ??
            null;
    }

    navigationForEntity(entity) {
        return this.navigationForDomain(
            entity?.domainId ??
                DEFAULT_WORLD_DOMAIN_ID,
        );
    }

    getDiagnostics() {
        const boundTopologyIds =
            new Set(
                this.domainBindings
                    .values(),
            );
        let overrideRoadCount = 0;
        let overrideEffectCount = 0;

        for (
            const instance of
            this.domainInstances.values()
        ) {
            overrideRoadCount +=
                instance.overrideRoadCount;
            overrideEffectCount +=
                instance.overrideEffectCount;
        }

        return {
            topologyCount:
                this.topologies.size,
            boundDomainCount:
                this.domainBindings.size,
            referencedTopologyCount:
                boundTopologyIds.size,
            overriddenDomainCount:
                this.domainInstances.size,
            overrideRoadCount,
            overrideEffectCount,
            defaultTopologyId:
                this.defaultTopologyId,
        };
    }

    assertInternalConsistency() {
        if (
            this.defaultTopologyId !=
                null &&
            !this.topologies.has(
                this.defaultTopologyId,
            )
        ) {
            throw new Error(
                `Default navigation topology is missing: ${this.defaultTopologyId}`,
            );
        }

        for (
            const [
                domainId,
                topologyId,
            ] of
            this.domainBindings
        ) {
            requireId(
                domainId,
                "World domain id",
            );

            if (
                !this.topologies.has(
                    topologyId,
                )
            ) {
                throw new Error(
                    `World domain ${domainId} references missing navigation topology: ${topologyId}`,
                );
            }
        }

        for (
            const [
                domainId,
                instance,
            ] of
            this.domainInstances
        ) {
            const topologyId =
                this.domainBindings.get(
                    domainId,
                );

            if (
                topologyId == null ||
                topologyId !==
                    instance.topologyId ||
                this.topologies.get(
                    topologyId,
                ) !==
                    instance.topology
            ) {
                throw new Error(
                    `Navigation instance binding drift: ${domainId}`,
                );
            }

            instance
                .assertInternalConsistency();
        }

        return this.getDiagnostics();
    }
}

export function navigationForEntity(
    navigationSource,
    entity,
) {
    if (
        navigationSource &&
        typeof navigationSource
            .navigationForEntity ===
                "function"
    ) {
        const navigation =
            navigationSource
                .navigationForEntity(
                    entity,
                );

        if (!navigation) {
            throw new Error(
                `No navigation topology is bound for world domain: ${entity?.domainId ?? DEFAULT_WORLD_DOMAIN_ID}`,
            );
        }

        return navigation;
    }

    return navigationSource;
}
