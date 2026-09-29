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

/**
 * Binds many world domains to a small set of shared Navigation topologies.
 *
 * A registered Navigation object is shared immutable-ish topology/state from
 * the registry's perspective: mutating it changes navigation for every bound
 * domain. Per-domain navigation overlays intentionally live outside this first
 * layer so domains with no overrides allocate no routing state at all.
 */
export class NavigationRegistry {
    constructor({
        defaultTopologyId = null,
    } = {}) {
        this.topologies = new Map();
        this.domainBindings =
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

        this.domainBindings.set(
            domainId,
            topologyId,
        );

        return this.topologies.get(
            topologyId,
        );
    }

    unbindDomain(domainId) {
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

    navigationForDomain(
        domainId =
            DEFAULT_WORLD_DOMAIN_ID,
    ) {
        const topologyId =
            this.topologyIdForDomain(
                domainId,
            );

        if (topologyId == null) {
            return null;
        }

        return (
            this.topologies.get(
                topologyId,
            ) ?? null
        );
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

        return {
            topologyCount:
                this.topologies.size,
            boundDomainCount:
                this.domainBindings.size,
            referencedTopologyCount:
                boundTopologyIds.size,
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
