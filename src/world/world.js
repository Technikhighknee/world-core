import { distanceSquared } from "./vec2.js";
import { SpatialHash } from "./spatial-hash.js";

export class World {
    constructor({
        spatialCellSize = 20,
        movementLodTiers = null,
        interestPoints = [],
    } = {}) {
        this.time = 0;
        this.entities = new Map();

        this.spatial = new SpatialHash(spatialCellSize);
        this.radiusCounts = new Map();
        this.maxEntityRadius = 0;

        this.movingEntities = new Set();
        this.movementBuckets = new Map();
        this.movementAccumulators = new Map();
        this.entityMovementIntervals = new Map();
        this.movementReclassifyScratch = [];

        this.movementLodTiers = null;
        this.interestPoints = [];

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
            return Math.max(0, explicit);
        }

        if (
            !this.movementLodTiers ||
            this.movementLodTiers.length === 0 ||
            this.interestPoints.length === 0
        ) {
            return 0;
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

    #assignMovementInterval(entityId, interval) {
        const current = this.entityMovementIntervals.get(entityId);

        if (current === interval) return;

        if (current != null) {
            this.movementBuckets.get(current)?.delete(entityId);
        }

        let bucket = this.movementBuckets.get(interval);

        if (!bucket) {
            bucket = new Set();
            this.movementBuckets.set(interval, bucket);
            this.movementAccumulators.set(interval, 0);
        }

        bucket.add(entityId);
        this.entityMovementIntervals.set(entityId, interval);
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
        this.spatial.upsert(stored.id, stored.position, radius);

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

        entity.position.x = x;
        entity.position.y = y;

        this.spatial.upsert(
            entity.id,
            entity.position,
            entity.body?.radius ?? 0,
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
        this.spatial.upsert(entity.id, entity.position, radius);
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

        this.movingEntities.add(entityId);
        this.#assignMovementInterval(
            entityId,
            this.#movementIntervalFor(entity),
        );
    }

    unmarkMoving(entityId) {
        this.movingEntities.delete(entityId);

        const interval = this.entityMovementIntervals.get(entityId);

        if (interval != null) {
            this.movementBuckets.get(interval)?.delete(entityId);
            this.entityMovementIntervals.delete(entityId);
        }
    }

    refreshEntityMovementLod(entityId) {
        if (!this.movingEntities.has(entityId)) return;

        const entity = this.entities.get(entityId);
        if (!entity) return;

        this.#assignMovementInterval(
            entityId,
            this.#movementIntervalFor(entity),
        );
    }

    refreshAllMovementLod() {
        for (const entityId of this.movingEntities) {
            this.refreshEntityMovementLod(entityId);
        }
    }

    forEachDueMovementBatch(deltaSeconds, callback) {
        for (const [interval, entityIds] of this.movementBuckets) {
            if (entityIds.size === 0) continue;

            if (interval === 0) {
                callback(entityIds, deltaSeconds);
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

            callback(entityIds, elapsedSeconds);
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
            diagnostics.movementIntervalEntries !==
            diagnostics.movingEntities
        ) {
            throw new Error(
                `Movement interval drift: ${diagnostics.movementIntervalEntries} interval entries for ${diagnostics.movingEntities} movers`,
            );
        }

        if (
            diagnostics.movementBucketMemberships !==
            diagnostics.movingEntities
        ) {
            throw new Error(
                `Movement bucket drift: ${diagnostics.movementBucketMemberships} bucket memberships for ${diagnostics.movingEntities} movers`,
            );
        }

        for (const entityId of this.movingEntities) {
            if (!this.entities.has(entityId)) {
                throw new Error(
                    `Moving entity missing from registry: ${entityId}`,
                );
            }

            if (!this.entityMovementIntervals.has(entityId)) {
                throw new Error(
                    `Moving entity missing interval: ${entityId}`,
                );
            }
        }

        return diagnostics;
    }
}
