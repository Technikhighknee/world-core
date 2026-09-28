import {
    circleIntersectsAabb,
    distanceSquaredPointToSegment,
} from "./geometry.js";
import { distanceSquared } from "./vec2.js";
import { SpatialHash } from "./spatial-hash.js";

export class World {
    constructor({
        spatialCellSize = 20,
        movementLodTiers = null,
        interestPoints = [],
        localSteering = null,
        captureEvents = false,
    } = {}) {
        this.time = 0;
        this.entities = new Map();

        this.captureEvents = Boolean(captureEvents);
        this.events = [];

        this.spatial = new SpatialHash(spatialCellSize);
        this.radiusCounts = new Map();
        this.maxEntityRadius = 0;

        this.movingEntities = new Map();
        this.movementBuckets = new Map();
        this.movementAccumulators = new Map();
        this.entityMovementIntervals = new Map();
        this.movementReclassifyScratch = [];

        this.movementLodTiers = null;
        this.interestPoints = [];

        this.localSteering = null;
        this.localSteeringQueryBuffer =
            this.createSpatialQueryBuffer();

        if (localSteering) {
            this.configureLocalSteering(
                localSteering,
            );
        }

        if (movementLodTiers) {
            this.configureMovementLod(movementLodTiers);
        }

        this.setInterestPoints(interestPoints);
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

    #movementIntervalFor(entity) {
        const explicit = entity.simulation?.movementInterval;

        if (explicit != null) {
            const interval = Math.max(0, explicit);
            return interval === 0 ? null : interval;
        }

        if (!this.hasDynamicMovementLod()) {
            return null;
        }

        let nearestSquared = Infinity;

        for (const point of this.interestPoints) {
            const value = distanceSquared(entity.position, point);
            if (value < nearestSquared) nearestSquared = value;
        }

        for (const tier of this.movementLodTiers) {
            if (nearestSquared <= tier.maxDistanceSquared) {
                return tier.interval;
            }
        }

        return this.movementLodTiers[this.movementLodTiers.length - 1].interval;
    }

    #assignMovementInterval(entity, interval) {
        const entityId = entity.id;
        const current = this.entityMovementIntervals.get(entityId);

        if (current === interval) return;

        if (current != null) {
            this.movementBuckets.get(current)?.delete(entity);
            this.entityMovementIntervals.delete(entityId);
        }

        if (interval == null) {
            return;
        }

        let bucket = this.movementBuckets.get(interval);

        if (!bucket) {
            bucket = new Set();
            this.movementBuckets.set(interval, bucket);
            this.movementAccumulators.set(interval, 0);
        }

        bucket.add(entity);
        this.entityMovementIntervals.set(entityId, interval);
    }

    setEventCapture(enabled) {
        this.captureEvents = Boolean(enabled);

        if (!this.captureEvents) {
            this.events.length = 0;
        }
    }

    emitEvent(type, data = {}) {
        if (!this.captureEvents) return null;

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

        const radius = stored.body.radius ?? 0;
        this.#trackRadius(radius);

        this.entities.set(stored.id, stored);
        this.spatial.upsertPoint(stored.id, stored.position);

        if (stored.journey) {
            this.markMoving(stored.id);
        }

        return stored;
    }

    removeEntity(entityId) {
        const entity = this.entities.get(entityId);
        if (!entity) return false;

        this.unmarkMoving(entityId);
        this.spatial.remove(entityId);
        this.#untrackRadius(entity.body?.radius ?? 0);

        return this.entities.delete(entityId);
    }

    getEntity(entityId) {
        return this.entities.get(entityId);
    }

    setPosition(entityId, position) {
        this.setPositionXY(entityId, position.x, position.y);
    }

    setPositionXY(entityId, x, y) {
        const entity = this.entities.get(entityId);

        if (!entity) {
            throw new Error(`Unknown entity: ${entityId}`);
        }

        this.setEntityPositionXY(entity, x, y);
    }

    setEntityPositionXY(entity, x, y) {
        entity.position.x = x;
        entity.position.y = y;

        this.spatial.upsertPoint(
            entity.id,
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

    configureMovementLod(tiers) {
        if (!Array.isArray(tiers) || tiers.length === 0) {
            this.movementLodTiers = null;
            this.refreshAllMovementLod();
            return;
        }

        let previousDistance = -Infinity;

        this.movementLodTiers = tiers.map(tier => {
            const maxDistance = tier.maxDistance ?? Infinity;
            const interval = tier.interval ?? 0;

            if (!(maxDistance > previousDistance)) {
                throw new Error("Movement LOD tiers must have increasing maxDistance values");
            }

            if (!(interval >= 0)) {
                throw new Error("Movement LOD interval must be greater than or equal to 0");
            }

            previousDistance = maxDistance;

            return {
                maxDistance,
                maxDistanceSquared:
                    maxDistance === Infinity ? Infinity : maxDistance * maxDistance,
                interval,
            };
        });

        this.refreshAllMovementLod();
    }

    setInterestPoints(points) {
        this.interestPoints = points.map(point => ({
            x: point.x,
            y: point.y,
        }));

        this.refreshAllMovementLod();
    }

    setMovementInterval(entityId, interval) {
        if (!(interval >= 0)) {
            throw new Error("Movement interval must be greater than or equal to 0");
        }

        const entity = this.entities.get(entityId);

        if (!entity) {
            throw new Error(`Unknown entity: ${entityId}`);
        }

        entity.simulation ??= {};
        entity.simulation.movementInterval = interval;
        this.refreshEntityMovementLod(entityId);
    }

    clearMovementInterval(entityId) {
        const entity = this.entities.get(entityId);
        if (!entity) return;

        if (entity.simulation) {
            delete entity.simulation.movementInterval;
        }

        this.refreshEntityMovementLod(entityId);
    }

    markMoving(entityId) {
        const entity = this.entities.get(entityId);

        if (!entity) {
            throw new Error(`Unknown entity: ${entityId}`);
        }

        this.movingEntities.set(entityId, entity);
        this.#assignMovementInterval(
            entity,
            this.#movementIntervalFor(entity),
        );
    }

    unmarkMoving(entityId) {
        const entity = this.movingEntities.get(entityId);
        this.movingEntities.delete(entityId);

        const interval = this.entityMovementIntervals.get(entityId);

        if (interval != null) {
            if (entity) {
                this.movementBuckets.get(interval)?.delete(entity);
            }

            this.entityMovementIntervals.delete(entityId);
        }
    }

    refreshEntityMovementLod(entityId) {
        const entity = this.movingEntities.get(entityId);
        if (!entity) return;

        this.#assignMovementInterval(
            entity,
            this.#movementIntervalFor(entity),
        );
    }

    hasDynamicMovementLod() {
        return Boolean(
            this.movementLodTiers?.length &&
            this.interestPoints.length > 0
        );
    }

    refreshAllMovementLod() {
        for (const entity of this.movingEntities.values()) {
            this.#assignMovementInterval(
                entity,
                this.#movementIntervalFor(entity),
            );
        }
    }

    forEachDueMovementBatch(deltaSeconds, callback) {
        const scheduledCount = this.entityMovementIntervals.size;

        if (scheduledCount < this.movingEntities.size) {
            callback(
                this.movingEntities.values(),
                deltaSeconds,
                scheduledCount > 0
                    ? this.entityMovementIntervals
                    : null,
            );
        }

        for (const [interval, entityIds] of this.movementBuckets) {
            if (entityIds.size === 0) continue;

            if (interval === 0) {
                callback(entityIds, deltaSeconds, null);
                continue;
            }

            const accumulated =
                (this.movementAccumulators.get(interval) ?? 0) + deltaSeconds;

            const dueIntervals = Math.floor((accumulated + 1e-9) / interval);

            if (dueIntervals <= 0) {
                this.movementAccumulators.set(interval, accumulated);
                continue;
            }

            const elapsedSeconds = dueIntervals * interval;
            this.movementAccumulators.set(
                interval,
                accumulated - elapsedSeconds,
            );

            callback(entityIds, elapsedSeconds, null);
        }
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
        { excludeId = null, predicate = null } = {},
    ) {
        const candidates = buffer.candidates;
        const results = buffer.results;

        results.length = 0;

        this.spatial.queryRadiusInto(
            candidates,
            position,
            radius + this.maxEntityRadius,
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
        { excludeId = null, predicate = null } = {},
    ) {
        if (minX > maxX || minY > maxY) {
            throw new Error("Invalid AABB bounds");
        }

        const candidates = buffer.candidates;
        const results = buffer.results;

        results.length = 0;

        this.spatial.queryBoundsInto(
            candidates,
            minX - this.maxEntityRadius,
            minY - this.maxEntityRadius,
            maxX + this.maxEntityRadius,
            maxY + this.maxEntityRadius,
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
        { excludeId = null, predicate = null } = {},
    ) {
        if (!(radius >= 0)) {
            throw new Error(
                "Capsule radius must be greater than or equal to 0",
            );
        }

        const candidates = buffer.candidates;
        const results = buffer.results;
        const broadRadius = radius + this.maxEntityRadius;

        results.length = 0;

        this.spatial.queryBoundsInto(
            candidates,
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
        } = {},
    ) {
        if (!(maxDistance >= 0)) {
            throw new Error(
                "maxDistance must be greater than or equal to 0",
            );
        }

        let candidates;

        if (Number.isFinite(maxDistance)) {
            candidates = this.spatial.queryRadius(
                position,
                maxDistance + this.maxEntityRadius,
            );
        } else {
            candidates = this.entities.keys();
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
        let movementBucketMemberships = 0;

        for (const bucket of this.movementBuckets.values()) {
            movementBucketMemberships += bucket.size;
        }

        let radiusTrackedEntities = 0;

        for (const count of this.radiusCounts.values()) {
            radiusTrackedEntities += count;
        }

        return {
            entityCount: this.entities.size,
            spatialIndexedEntities: this.spatial.entityRanges.size,
            spatialCellCount: this.spatial.cells.size,
            spatialMemberships: this.spatial.membershipCount(),
            spatialMultiOccupancyCells:
                this.spatial.multiOccupancyCellCount(),
            movingEntities: this.movingEntities.size,
            movementIntervalEntries: this.entityMovementIntervals.size,
            movementBucketCount: this.movementBuckets.size,
            movementBucketMemberships,
            radiusTrackedEntities,
            radiusCountEntries: this.radiusCounts.size,
            maxEntityRadius: this.maxEntityRadius,
        };
    }

    assertInternalConsistency() {
        const diagnostics = this.getDiagnostics();

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
            diagnostics.movementBucketMemberships !==
            diagnostics.movementIntervalEntries
        ) {
            throw new Error(
                `Movement scheduling drift: ${diagnostics.movementBucketMemberships} bucket memberships for ${diagnostics.movementIntervalEntries} scheduled movers`,
            );
        }

        if (
            diagnostics.movementIntervalEntries >
            diagnostics.movingEntities
        ) {
            throw new Error(
                `Movement scheduling overflow: ${diagnostics.movementIntervalEntries} scheduled movers for ${diagnostics.movingEntities} active movers`,
            );
        }

        for (const [entityId, entity] of this.movingEntities) {
            if (this.entities.get(entityId) !== entity) {
                throw new Error(
                    `Moving entity registry mismatch: ${entityId}`,
                );
            }
        }

        for (const entityId of this.entityMovementIntervals.keys()) {
            if (!this.movingEntities.has(entityId)) {
                throw new Error(
                    `Scheduled entity is not moving: ${entityId}`,
                );
            }
        }

        return diagnostics;
    }
}
