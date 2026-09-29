import {
    circleIntersectsAabb,
    distanceSquaredPointToSegment,
} from "./geometry.js";
import { DomainSpatialIndex } from "./domain-spatial-index.js";
import { ObstacleField } from "./obstacle-field.js";

export const DEFAULT_WORLD_DOMAIN_ID = "default";

export class World {
    constructor({
        spatialCellSize = 20,
        obstacleCellSize = spatialCellSize,
        domains = [],
        localSteering = null,
        captureEvents = false,
        eventQueueLimit = 10000,
        eventOverflowPolicy = "drop-newest",
    } = {}) {
        this.time = 0;
        this.entities = new Map();

        this.domains = new Map();
        this.domainsByHandle = [];
        this.nextDomainHandle = 0;
        this.addDomain({
            id: DEFAULT_WORLD_DOMAIN_ID,
        });

        for (const domain of domains) {
            if (
                domain?.id ===
                DEFAULT_WORLD_DOMAIN_ID
            ) {
                continue;
            }

            this.addDomain(domain);
        }

        this.captureEvents = Boolean(captureEvents);
        this.events = [];
        this.eventQueueLimit = 0;
        this.eventOverflowPolicy = "drop-newest";
        this.droppedEventCount = 0;

        this.configureEventQueue({
            limit: eventQueueLimit,
            overflowPolicy:
                eventOverflowPolicy,
        });

        this.spatial = new DomainSpatialIndex(spatialCellSize);
        this.obstacles =
            new ObstacleField(
                obstacleCellSize,
            );
        this.domainObstacleFields =
            new Map();
        this.obstacleDomains =
            new Map();
        this.obstacleQueryCandidates =
            new Set();
        this.obstacleQueryResults = [];

        this.radiusCounts = new Map();
        this.maxEntityRadius = 0;

        this.movingEntities = new Map();

        this.localSteering = null;
        this.localSteeringQueryBuffer =
            this.createSpatialQueryBuffer();

        if (localSteering) {
            this.configureLocalSteering(
                localSteering,
            );
        }

    }

    #trackRadius(radius) {
        const count = this.radiusCounts.get(radius) ?? 0;
        this.radiusCounts.set(radius, count + 1);

        if (radius > this.maxEntityRadius) {
            this.maxEntityRadius = radius;
        }
    }

    #untrackRadius(radius) {
        const count = this.radiusCounts.get(radius);
        if (count == null) return;

        if (count <= 1) {
            this.radiusCounts.delete(radius);
        } else {
            this.radiusCounts.set(radius, count - 1);
        }

        if (radius !== this.maxEntityRadius || this.radiusCounts.has(radius)) {
            return;
        }

        let nextMax = 0;

        for (const value of this.radiusCounts.keys()) {
            if (value > nextMax) nextMax = value;
        }

        this.maxEntityRadius = nextMax;
    }

    #requireDomain(
        domainId =
            DEFAULT_WORLD_DOMAIN_ID,
    ) {
        const domain =
            this.domains.get(domainId);

        if (!domain) {
            throw new Error(
                `Unknown world domain: ${domainId}`,
            );
        }

        return domain;
    }

    #queryDomain(
        domainId,
        excludeId,
    ) {
        if (domainId != null) {
            return this.#requireDomain(
                domainId,
            );
        }

        if (excludeId != null) {
            const entity =
                this.entities.get(
                    excludeId,
                );

            if (entity) {
                return this.#requireDomain(
                    entity.domainId,
                );
            }
        }

        return this.#requireDomain(
            DEFAULT_WORLD_DOMAIN_ID,
        );
    }

    #recalculateDomainMaxRadius(
        domain,
    ) {
        let maxRadius = 0;

        for (
            const entityId of
            this.spatial.members(
                domain.handle,
            )
        ) {
            const entity =
                this.entities.get(
                    entityId,
                );

            if (!entity) continue;

            const radius =
                entity.body?.radius ??
                0;

            if (radius > maxRadius) {
                maxRadius = radius;
            }
        }

        domain.maxEntityRadius =
            maxRadius;
        return maxRadius;
    }

    addDomain({ id }) {
        if (
            typeof id !== "string" ||
            id.length === 0
        ) {
            throw new Error(
                "World domain id must be a non-empty string",
            );
        }

        if (this.domains.has(id)) {
            throw new Error(
                `World domain already exists: ${id}`,
            );
        }

        const domain = {
            id,
            handle:
                this.nextDomainHandle++,
            entityCount: 0,
            maxEntityRadius: 0,
        };

        this.domains.set(id, domain);
        this.domainsByHandle[
            domain.handle
        ] = domain;
        return domain;
    }

    removeDomain(domainId) {
        if (
            domainId ===
            DEFAULT_WORLD_DOMAIN_ID
        ) {
            throw new Error(
                "Cannot remove the default world domain",
            );
        }

        const domain =
            this.domains.get(domainId);

        if (!domain) return false;

        if (domain.entityCount > 0) {
            throw new Error(
                `Cannot remove non-empty world domain: ${domainId}`,
            );
        }

        const obstacleField =
            this.domainObstacleFields.get(
                domain.handle,
            );

        if (
            obstacleField &&
            obstacleField.obstacles.size >
                0
        ) {
            throw new Error(
                `Cannot remove world domain with obstacles: ${domainId}`,
            );
        }

        this.domainObstacleFields.delete(
            domain.handle,
        );
        this.domainsByHandle[
            domain.handle
        ] = undefined;

        return this.domains.delete(
            domainId,
        );
    }

    getDomain(domainId) {
        return this.domains.get(
            domainId,
        );
    }

    getEntityDomain(entityId) {
        const entity =
            this.entities.get(entityId);

        if (!entity) return null;

        return this.domains.get(
            entity.domainId,
        ) ?? null;
    }

    configureEventQueue({
        limit =
            this.eventQueueLimit,
        overflowPolicy =
            this.eventOverflowPolicy,
    } = {}) {
        if (
            !Number.isInteger(limit) ||
            limit < 0
        ) {
            throw new Error(
                "eventQueueLimit must be an integer greater than or equal to 0",
            );
        }

        if (
            overflowPolicy !==
                "drop-newest" &&
            overflowPolicy !==
                "drop-oldest" &&
            overflowPolicy !==
                "throw"
        ) {
            throw new Error(
                "eventOverflowPolicy must be \"drop-newest\", \"drop-oldest\", or \"throw\"",
            );
        }

        this.eventQueueLimit = limit;
        this.eventOverflowPolicy =
            overflowPolicy;

        if (
            this.events.length >
            limit
        ) {
            const overflow =
                this.events.length -
                limit;

            if (limit === 0) {
                this.events.length = 0;
            } else {
                this.events.splice(
                    0,
                    overflow,
                );
            }

            this.droppedEventCount +=
                overflow;
        }

        return {
            limit:
                this.eventQueueLimit,
            overflowPolicy:
                this.eventOverflowPolicy,
        };
    }

    getEventQueueStats() {
        return {
            size: this.events.length,
            limit:
                this.eventQueueLimit,
            overflowPolicy:
                this.eventOverflowPolicy,
            dropped:
                this.droppedEventCount,
        };
    }

    resetDroppedEventCount() {
        const previous =
            this.droppedEventCount;

        this.droppedEventCount = 0;
        return previous;
    }

    setEventCapture(enabled) {
        this.captureEvents = Boolean(enabled);

        if (!this.captureEvents) {
            this.events.length = 0;
        }
    }

    #assertEventCapacity(
        additionalEvents,
    ) {
        if (
            !this.captureEvents ||
            this.eventOverflowPolicy !==
                "throw" ||
            additionalEvents <= 0
        ) {
            return;
        }

        if (
            this.events.length +
                additionalEvents >
            this.eventQueueLimit
        ) {
            throw new Error(
                `Event queue limit exceeded: ${this.eventQueueLimit}`,
            );
        }
    }

    emitEvent(type, data = {}) {
        if (!this.captureEvents) return null;

        if (
            this.events.length >=
            this.eventQueueLimit
        ) {
            if (
                this.eventOverflowPolicy ===
                "throw"
            ) {
                throw new Error(
                    `Event queue limit exceeded: ${this.eventQueueLimit}`,
                );
            }

            this.droppedEventCount++;

            if (
                this.eventOverflowPolicy ===
                "drop-newest"
            ) {
                return null;
            }

            if (
                this.eventQueueLimit === 0
            ) {
                return null;
            }

            this.events.shift();
        }

        if (this.eventQueueLimit === 0) {
            this.droppedEventCount++;
            return null;
        }

        const event = {
            time: this.time,
            type,
            ...data,
        };

        this.events.push(event);
        return event;
    }

    drainEvents(target = []) {
        target.length = 0;

        for (const event of this.events) {
            target.push(event);
        }

        this.events.length = 0;
        return target;
    }

    peekEvents() {
        return this.events;
    }

    #obstacleFieldForDomain(
        domainId,
        create = false,
    ) {
        const domain =
            this.#requireDomain(
                domainId ??
                    DEFAULT_WORLD_DOMAIN_ID,
            );

        if (
            domain.id ===
            DEFAULT_WORLD_DOMAIN_ID
        ) {
            return this.obstacles;
        }

        let field =
            this.domainObstacleFields.get(
                domain.handle,
            );

        if (!field && create) {
            field =
                new ObstacleField(
                    this.obstacles.index
                        .cellSize,
                );

            this.domainObstacleFields.set(
                domain.handle,
                field,
            );
        }

        return field ?? null;
    }

    addObstacle(
        obstacle,
        {
            domainId =
                DEFAULT_WORLD_DOMAIN_ID,
        } = {},
    ) {
        if (
            this.obstacleDomains.has(
                obstacle.id,
            )
        ) {
            throw new Error(
                `Obstacle already exists: ${obstacle.id}`,
            );
        }

        const domain =
            this.#requireDomain(
                domainId,
            );
        const field =
            this.#obstacleFieldForDomain(
                domain.id,
                true,
            );
        const stored =
            field.add(obstacle);

        this.obstacleDomains.set(
            stored.id,
            domain.id,
        );

        return stored;
    }

    getObstacle(obstacleId) {
        const domainId =
            this.obstacleDomains.get(
                obstacleId,
            );

        if (domainId == null) {
            return undefined;
        }

        return this
            .#obstacleFieldForDomain(
                domainId,
            )
            ?.obstacles.get(
                obstacleId,
            );
    }

    getObstacleDomain(
        obstacleId,
    ) {
        return (
            this.obstacleDomains.get(
                obstacleId,
            ) ?? null
        );
    }

    removeObstacle(obstacleId) {
        const domainId =
            this.obstacleDomains.get(
                obstacleId,
            );

        if (domainId == null) {
            return false;
        }

        const domain =
            this.#requireDomain(
                domainId,
            );
        const field =
            this.#obstacleFieldForDomain(
                domainId,
            );

        if (
            !field ||
            !field.remove(obstacleId)
        ) {
            return false;
        }

        this.obstacleDomains.delete(
            obstacleId,
        );

        if (
            domainId !==
                DEFAULT_WORLD_DOMAIN_ID &&
            field.obstacles.size === 0
        ) {
            this.domainObstacleFields.delete(
                domain.handle,
            );
        }

        return true;
    }

    setObstacleEnabled(
        obstacleId,
        enabled,
    ) {
        const domainId =
            this.obstacleDomains.get(
                obstacleId,
            );

        if (domainId == null) {
            throw new Error(
                `Unknown obstacle: ${obstacleId}`,
            );
        }

        return this
            .#obstacleFieldForDomain(
                domainId,
            )
            .setEnabled(
                obstacleId,
                enabled,
            );
    }

    replaceObstacle(
        obstacleId,
        patch,
    ) {
        const domainId =
            this.obstacleDomains.get(
                obstacleId,
            );

        if (domainId == null) {
            throw new Error(
                `Unknown obstacle: ${obstacleId}`,
            );
        }

        return this
            .#obstacleFieldForDomain(
                domainId,
            )
            .replace(
                obstacleId,
                patch,
            );
    }

    queryObstaclesRadiusInto(
        position,
        radius,
        results =
            this.obstacleQueryResults,
        {
            includeDisabled = false,
            predicate = null,
            domainId =
                DEFAULT_WORLD_DOMAIN_ID,
        } = {},
    ) {
        const field =
            this.#obstacleFieldForDomain(
                domainId,
            );

        if (!field) {
            results.length = 0;
            return results;
        }

        return field.queryRadiusInto(
            results,
            position,
            radius,
            this.obstacleQueryCandidates,
            {
                includeDisabled,
                predicate,
            },
        );
    }

    addEntity(entity) {
        if (this.entities.has(entity.id)) {
            throw new Error(`Entity already exists: ${entity.id}`);
        }

        if (!entity.position) {
            throw new Error(`Entity ${entity.id} has no position`);
        }

        let stored;

        if (entity.mobility && Object.isFrozen(entity.mobility)) {
            const { mobility, ...cloneable } = entity;
            stored = structuredClone(cloneable);
            stored.mobility = mobility;
        } else {
            stored = structuredClone(entity);
        }

        stored.body ??= { radius: 0.35 };

        const domain =
            this.#requireDomain(
                stored.domainId ??
                    DEFAULT_WORLD_DOMAIN_ID,
            );

        stored.domainId = domain.id;

        const radius = stored.body.radius ?? 0;
        this.#trackRadius(radius);

        this.entities.set(stored.id, stored);
        domain.entityCount++;
        domain.maxEntityRadius =
            Math.max(
                domain.maxEntityRadius,
                radius,
            );

        this.spatial.upsertPoint(
            stored.id,
            domain.handle,
            stored.position,
        );

        if (stored.journey) {
            this.markMoving(stored.id);
        }

        return stored;
    }

    removeEntity(entityId) {
        const entity = this.entities.get(entityId);
        if (!entity) return false;

        this.unmarkMoving(entityId);

        const domain =
            this.#requireDomain(
                entity.domainId,
            );
        const radius =
            entity.body?.radius ??
            0;

        this.spatial.remove(entityId);
        this.#untrackRadius(radius);

        domain.entityCount--;

        const removed =
            this.entities.delete(
                entityId,
            );

        if (
            radius ===
            domain.maxEntityRadius
        ) {
            this.#recalculateDomainMaxRadius(
                domain,
            );
        }

        return removed;
    }

    getEntity(entityId) {
        return this.entities.get(entityId);
    }

    transferEntity(
        entityId,
        {
            domainId,
            position,
        },
    ) {
        const entity =
            this.entities.get(entityId);

        if (!entity) {
            throw new Error(
                `Unknown entity: ${entityId}`,
            );
        }

        if (
            !position ||
            !Number.isFinite(position.x) ||
            !Number.isFinite(position.y)
        ) {
            throw new Error(
                "Domain transfer position must contain finite x/y coordinates",
            );
        }

        const previousDomain =
            this.#requireDomain(
                entity.domainId,
            );
        const nextDomain =
            this.#requireDomain(
                domainId,
            );

        if (
            previousDomain.handle ===
            nextDomain.handle
        ) {
            this.setEntityPositionXY(
                entity,
                position.x,
                position.y,
            );

            return entity;
        }

        const previousPosition = {
            x: entity.position.x,
            y: entity.position.y,
        };

        this.#assertEventCapacity(
            entity.journey
                ? 2
                : 1,
        );

        try {
            entity.domainId =
                nextDomain.id;
            entity.position.x =
                position.x;
            entity.position.y =
                position.y;

            this.spatial.upsertPoint(
                entity.id,
                nextDomain.handle,
                entity.position,
            );

            previousDomain.entityCount--;
            nextDomain.entityCount++;

            const radius =
                entity.body?.radius ??
                0;

            nextDomain.maxEntityRadius =
                Math.max(
                    nextDomain.maxEntityRadius,
                    radius,
                );

            if (
                radius ===
                previousDomain
                    .maxEntityRadius
            ) {
                this.#recalculateDomainMaxRadius(
                    previousDomain,
                );
            }
        } catch (error) {
            entity.domainId =
                previousDomain.id;
            entity.position.x =
                previousPosition.x;
            entity.position.y =
                previousPosition.y;

            this.spatial.upsertPoint(
                entity.id,
                previousDomain.handle,
                entity.position,
            );

            this.#recalculateDomainMaxRadius(
                previousDomain,
            );
            this.#recalculateDomainMaxRadius(
                nextDomain,
            );

            throw error;
        }

        if (entity.journey) {
            const destinationNodeId =
                entity.journey
                    .destinationNodeId;

            entity.journey = null;
            this.unmarkMoving(
                entity.id,
            );

            this.emitEvent(
                "journeyCancelled",
                {
                    entityId:
                        entity.id,
                    destinationNodeId,
                    reason:
                        "domain-transfer",
                },
            );
        }

        this.emitEvent(
            "entityDomainTransferred",
            {
                entityId: entity.id,
                fromDomainId:
                    previousDomain.id,
                toDomainId:
                    nextDomain.id,
            },
        );

        return entity;
    }

    setPosition(entityId, position) {
        this.setPositionXY(entityId, position.x, position.y);
    }

    setPositionXY(entityId, x, y) {
        const entity = this.entities.get(entityId);

        if (!entity) {
            throw new Error(`Unknown entity: ${entityId}`);
        }

        this.setEntityPositionXY(
            entity,
            x,
            y,
        );
    }

    setEntityPositionXY(
        entity,
        x,
        y,
    ) {
        entity.position.x = x;
        entity.position.y = y;

        const domain =
            this.#requireDomain(
                entity.domainId,
            );

        this.spatial.upsertPoint(
            entity.id,
            domain.handle,
            entity.position,
        );

    }

    setEntityRadius(entityId, radius) {
        if (!(radius >= 0)) {
            throw new Error("Entity radius must be greater than or equal to 0");
        }

        const entity = this.entities.get(entityId);

        if (!entity) {
            throw new Error(`Unknown entity: ${entityId}`);
        }

        const previous = entity.body?.radius ?? 0;

        entity.body ??= {};
        entity.body.radius = radius;

        this.#untrackRadius(previous);
        this.#trackRadius(radius);

        const domain =
            this.#requireDomain(
                entity.domainId,
            );

        if (
            radius >=
            domain.maxEntityRadius
        ) {
            domain.maxEntityRadius =
                radius;
        } else if (
            previous ===
            domain.maxEntityRadius
        ) {
            this.#recalculateDomainMaxRadius(
                domain,
            );
        }
    }

    configureLocalSteering(options = {}) {
        const enabled =
            options.enabled ?? true;

        const config = {
            enabled: Boolean(enabled),
            neighborRadius:
                options.neighborRadius ?? 2.5,
            separationGap:
                options.separationGap ?? 0.1,
            separationStrength:
                options.separationStrength ?? 0.75,
            maxLateralSpeed:
                options.maxLateralSpeed ?? 0.8,
            centeringRate:
                options.centeringRate ?? 0.6,
            counterflowStrength:
                options.counterflowStrength ?? 0.8,
            trafficSide:
                options.trafficSide ?? "right",
            obstacleLookahead:
                options.obstacleLookahead ??
                options.neighborRadius ??
                2.5,
            obstacleMargin:
                options.obstacleMargin ?? 0.15,
            obstacleStrength:
                options.obstacleStrength ?? 1.2,
            obstacleForwardPressure:
                options.obstacleForwardPressure ?? 0.75,
            roadEdgeMargin:
                options.roadEdgeMargin ?? 0.05,
            congestionThreshold:
                options.congestionThreshold ?? 1,
            congestionStrength:
                options.congestionStrength ?? 0.65,
            forwardPressureWeight:
                options.forwardPressureWeight ?? 0.35,
            minSpeedMultiplier:
                options.minSpeedMultiplier ?? 0.2,
        };

        if (!(config.neighborRadius > 0)) {
            throw new Error(
                "localSteering.neighborRadius must be greater than 0",
            );
        }

        if (!(config.separationGap >= 0)) {
            throw new Error(
                "localSteering.separationGap must be greater than or equal to 0",
            );
        }

        if (!(config.maxLateralSpeed >= 0)) {
            throw new Error(
                "localSteering.maxLateralSpeed must be greater than or equal to 0",
            );
        }

        if (!(config.centeringRate >= 0)) {
            throw new Error(
                "localSteering.centeringRate must be greater than or equal to 0",
            );
        }

        if (!(config.counterflowStrength >= 0)) {
            throw new Error(
                "localSteering.counterflowStrength must be greater than or equal to 0",
            );
        }

        if (
            config.trafficSide !== "right" &&
            config.trafficSide !== "left"
        ) {
            throw new Error(
                "localSteering.trafficSide must be \"right\" or \"left\"",
            );
        }

        if (!(config.obstacleLookahead >= 0)) {
            throw new Error(
                "localSteering.obstacleLookahead must be greater than or equal to 0",
            );
        }

        if (!(config.obstacleMargin >= 0)) {
            throw new Error(
                "localSteering.obstacleMargin must be greater than or equal to 0",
            );
        }

        if (!(config.obstacleStrength >= 0)) {
            throw new Error(
                "localSteering.obstacleStrength must be greater than or equal to 0",
            );
        }

        if (!(config.obstacleForwardPressure >= 0)) {
            throw new Error(
                "localSteering.obstacleForwardPressure must be greater than or equal to 0",
            );
        }

        if (
            !(
                config.minSpeedMultiplier >
                0 &&
                config.minSpeedMultiplier <= 1
            )
        ) {
            throw new Error(
                "localSteering.minSpeedMultiplier must be in (0, 1]",
            );
        }

        this.localSteering = config;
        return config;
    }

    disableLocalSteering() {
        if (!this.localSteering) {
            this.localSteering = {
                enabled: false,
            };
            return;
        }

        this.localSteering.enabled = false;
    }

    markMoving(entityId) {
        const entity =
            this.entities.get(entityId);

        if (!entity) {
            throw new Error(
                `Unknown entity: ${entityId}`,
            );
        }

        this.movingEntities.set(
            entityId,
            entity,
        );
    }

    unmarkMoving(entityId) {
        this.movingEntities.delete(
            entityId,
        );
    }

    createSpatialQueryBuffer() {
        return {
            candidates: new Set(),
            results: [],
        };
    }

    queryRadiusInto(
        position,
        radius,
        buffer,
        {
            excludeId = null,
            predicate = null,
            domainId = null,
        } = {},
    ) {
        const domain =
            this.#queryDomain(
                domainId,
                excludeId,
            );
        const candidates = buffer.candidates;
        const results = buffer.results;

        results.length = 0;

        this.spatial.queryRadiusInto(
            candidates,
            domain.handle,
            position,
            radius + domain.maxEntityRadius,
        );

        for (const entityId of candidates) {
            if (entityId === excludeId) continue;

            const entity = this.entities.get(entityId);
            if (!entity) continue;

            const actualRadius = radius + (entity.body?.radius ?? 0);
            const actualRadiusSquared = actualRadius * actualRadius;

            if (distanceSquared(position, entity.position) > actualRadiusSquared) continue;
            if (predicate && !predicate(entity)) continue;

            results.push(entity);
        }

        return results;
    }

    queryRadius(position, radius, options = {}) {
        return this.queryRadiusInto(
            position,
            radius,
            this.createSpatialQueryBuffer(),
            options,
        );
    }

    queryAabbInto(
        minX,
        minY,
        maxX,
        maxY,
        buffer,
        {
            excludeId = null,
            predicate = null,
            domainId = null,
        } = {},
    ) {
        const domain =
            this.#queryDomain(
                domainId,
                excludeId,
            );

        if (minX > maxX || minY > maxY) {
            throw new Error("Invalid AABB bounds");
        }

        const candidates = buffer.candidates;
        const results = buffer.results;

        results.length = 0;

        this.spatial.queryBoundsInto(
            candidates,
            domain.handle,
            minX - domain.maxEntityRadius,
            minY - domain.maxEntityRadius,
            maxX + domain.maxEntityRadius,
            maxY + domain.maxEntityRadius,
        );

        for (const entityId of candidates) {
            if (entityId === excludeId) continue;

            const entity = this.entities.get(entityId);
            if (!entity) continue;

            const radius = entity.body?.radius ?? 0;

            if (
                !circleIntersectsAabb(
                    entity.position,
                    radius,
                    minX,
                    minY,
                    maxX,
                    maxY,
                )
            ) {
                continue;
            }

            if (predicate && !predicate(entity)) continue;

            results.push(entity);
        }

        return results;
    }

    queryAabb(
        minX,
        minY,
        maxX,
        maxY,
        options = {},
    ) {
        return this.queryAabbInto(
            minX,
            minY,
            maxX,
            maxY,
            this.createSpatialQueryBuffer(),
            options,
        );
    }

    queryCapsuleInto(
        a,
        b,
        radius,
        buffer,
        {
            excludeId = null,
            predicate = null,
            domainId = null,
        } = {},
    ) {
        const domain =
            this.#queryDomain(
                domainId,
                excludeId,
            );

        if (!(radius >= 0)) {
            throw new Error(
                "Capsule radius must be greater than or equal to 0",
            );
        }

        const candidates = buffer.candidates;
        const results = buffer.results;
        const broadRadius = radius + domain.maxEntityRadius;

        results.length = 0;

        this.spatial.queryBoundsInto(
            candidates,
            domain.handle,
            Math.min(a.x, b.x) - broadRadius,
            Math.min(a.y, b.y) - broadRadius,
            Math.max(a.x, b.x) + broadRadius,
            Math.max(a.y, b.y) + broadRadius,
        );

        for (const entityId of candidates) {
            if (entityId === excludeId) continue;

            const entity = this.entities.get(entityId);
            if (!entity) continue;

            const actualRadius =
                radius + (entity.body?.radius ?? 0);

            if (
                distanceSquaredPointToSegment(
                    entity.position,
                    a,
                    b,
                ) >
                actualRadius * actualRadius
            ) {
                continue;
            }

            if (predicate && !predicate(entity)) continue;

            results.push(entity);
        }

        return results;
    }

    queryCapsule(
        a,
        b,
        radius,
        options = {},
    ) {
        return this.queryCapsuleInto(
            a,
            b,
            radius,
            this.createSpatialQueryBuffer(),
            options,
        );
    }

    querySegmentInto(
        a,
        b,
        buffer,
        options = {},
    ) {
        return this.queryCapsuleInto(
            a,
            b,
            0,
            buffer,
            options,
        );
    }

    querySegment(a, b, options = {}) {
        return this.querySegmentInto(
            a,
            b,
            this.createSpatialQueryBuffer(),
            options,
        );
    }

    queryNearest(
        position,
        {
            maxDistance = Infinity,
            excludeId = null,
            predicate = null,
            domainId = null,
        } = {},
    ) {
        const domain =
            this.#queryDomain(
                domainId,
                excludeId,
            );

        if (!(maxDistance >= 0)) {
            throw new Error(
                "maxDistance must be greater than or equal to 0",
            );
        }

        let candidates;

        if (Number.isFinite(maxDistance)) {
            candidates = this.spatial.queryRadius(
                domain.handle,
                position,
                maxDistance + domain.maxEntityRadius,
            );
        } else {
            candidates =
                this.spatial.members(
                    domain.handle,
                );
        }

        let best = null;

        for (const entityId of candidates) {
            if (entityId === excludeId) continue;

            const entity = this.entities.get(entityId);
            if (!entity) continue;
            if (predicate && !predicate(entity)) continue;

            const centerDistanceSquared =
                distanceSquared(
                    position,
                    entity.position,
                );
            const centerDistance =
                Math.sqrt(centerDistanceSquared);
            const bodyDistance = Math.max(
                0,
                centerDistance -
                    (entity.body?.radius ?? 0),
            );

            if (bodyDistance > maxDistance) continue;

            if (
                !best ||
                bodyDistance < best.distance ||
                (
                    bodyDistance === best.distance &&
                    entity.id < best.entity.id
                )
            ) {
                best = {
                    entity,
                    distance: bodyDistance,
                    centerDistance,
                };
            }
        }

        return best;
    }

    getDiagnostics() {
        let radiusTrackedEntities = 0;

        for (const count of this.radiusCounts.values()) {
            radiusTrackedEntities += count;
        }

        return {
            entityCount: this.entities.size,
            spatialIndexedEntities: this.spatial.entityRanges.size,
            spatialCellCount:
                this.spatial.cellCount(),
            spatialMemberships: this.spatial.membershipCount(),
            spatialMultiOccupancyCells:
                this.spatial.multiOccupancyCellCount(),
            domainCount:
                this.domains.size,
            occupiedSpatialDomainCount:
                this.spatial.occupiedDomainCount(),
            movingEntities: this.movingEntities.size,
            radiusTrackedEntities,
            radiusCountEntries: this.radiusCounts.size,
            maxEntityRadius: this.maxEntityRadius,
            obstacleCount:
                this.obstacleDomains.size,
            obstacleIndexMemberships:
                this.obstacles.index.membershipCount() +
                [...this.domainObstacleFields.values()]
                    .reduce(
                        (total, field) =>
                            total +
                            field.index.membershipCount(),
                        0,
                    ),
            occupiedObstacleDomainCount:
                this.domainObstacleFields.size +
                (
                    this.obstacles.obstacles.size >
                        0
                        ? 1
                        : 0
                ),
            eventQueueSize:
                this.events.length,
            eventQueueLimit:
                this.eventQueueLimit,
            droppedEventCount:
                this.droppedEventCount,
        };
    }

    assertInternalConsistency() {
        const diagnostics = this.getDiagnostics();

        this.spatial.assertInternalConsistency();

        const defaultDomain =
            this.domains.get(
                DEFAULT_WORLD_DOMAIN_ID,
            );

        if (
            !defaultDomain ||
            defaultDomain.handle !== 0
        ) {
            throw new Error(
                "Default world domain is missing or has an invalid handle",
            );
        }

        const actualDomainCounts =
            new Map();
        const actualDomainMaxRadii =
            new Map();

        for (
            const entity of
            this.entities.values()
        ) {
            if (
                !this.domains.has(
                    entity.domainId,
                )
            ) {
                throw new Error(
                    `Entity references unknown world domain: ${String(entity.id)} -> ${entity.domainId}`,
                );
            }

            actualDomainCounts.set(
                entity.domainId,
                (
                    actualDomainCounts.get(
                        entity.domainId,
                    ) ?? 0
                ) + 1,
            );

            actualDomainMaxRadii.set(
                entity.domainId,
                Math.max(
                    actualDomainMaxRadii.get(
                        entity.domainId,
                    ) ?? 0,
                    entity.body?.radius ??
                        0,
                ),
            );
        }

        let domainEntityCount = 0;

        for (
            const [domainId, domain] of
            this.domains
        ) {
            if (
                domain.id !== domainId ||
                !Number.isInteger(
                    domain.handle,
                ) ||
                domain.handle < 0 ||
                !Number.isInteger(
                    domain.entityCount,
                ) ||
                domain.entityCount < 0 ||
                !Number.isFinite(
                    domain.maxEntityRadius,
                ) ||
                domain.maxEntityRadius < 0
            ) {
                throw new Error(
                    `Invalid world domain state: ${domainId}`,
                );
            }

            const actualCount =
                actualDomainCounts.get(
                    domainId,
                ) ?? 0;

            if (
                domain.entityCount !==
                actualCount
            ) {
                throw new Error(
                    `World domain entity drift for ${domainId}: ${domain.entityCount} tracked for ${actualCount} entities`,
                );
            }

            const actualMaxRadius =
                actualDomainMaxRadii.get(
                    domainId,
                ) ?? 0;

            if (
                domain.maxEntityRadius !==
                actualMaxRadius
            ) {
                throw new Error(
                    `World domain radius drift for ${domainId}: ${domain.maxEntityRadius} tracked for ${actualMaxRadius}`,
                );
            }

            domainEntityCount +=
                domain.entityCount;
        }

        if (
            domainEntityCount !==
            diagnostics.entityCount
        ) {
            throw new Error(
                `World domain entity drift: ${domainEntityCount} assigned for ${diagnostics.entityCount} entities`,
            );
        }

        if (
            diagnostics.spatialIndexedEntities !==
            diagnostics.entityCount
        ) {
            throw new Error(
                `Spatial index drift: ${diagnostics.spatialIndexedEntities} indexed for ${diagnostics.entityCount} entities`,
            );
        }

        if (
            diagnostics.radiusTrackedEntities !==
            diagnostics.entityCount
        ) {
            throw new Error(
                `Radius tracking drift: ${diagnostics.radiusTrackedEntities} tracked for ${diagnostics.entityCount} entities`,
            );
        }

        if (
            diagnostics.eventQueueSize >
            diagnostics.eventQueueLimit
        ) {
            throw new Error(
                `Event queue overflow: ${diagnostics.eventQueueSize} events for limit ${diagnostics.eventQueueLimit}`,
            );
        }

        this.obstacles.assertInternalConsistency();

        for (
            const [
                domainHandle,
                field,
            ] of
            this.domainObstacleFields
        ) {
            const domain =
                this.domainsByHandle[
                    domainHandle
                ];

            if (!domain) {
                throw new Error(
                    `Obstacle field references missing world domain handle: ${domainHandle}`,
                );
            }

            if (
                field.obstacles.size ===
                0
            ) {
                throw new Error(
                    `Empty obstacle field retained for world domain: ${domain.id}`,
                );
            }

            field.assertInternalConsistency();
        }

        if (
            this.obstacleDomains.size !==
            diagnostics.obstacleCount
        ) {
            throw new Error(
                "Obstacle domain registry drift",
            );
        }

        for (
            const [
                obstacleId,
                domainId,
            ] of
            this.obstacleDomains
        ) {
            const field =
                this.#obstacleFieldForDomain(
                    domainId,
                );

            if (
                !field?.obstacles.has(
                    obstacleId,
                )
            ) {
                throw new Error(
                    `Obstacle domain registry references missing obstacle: ${String(obstacleId)}`,
                );
            }
        }

        return diagnostics;
    }
}
