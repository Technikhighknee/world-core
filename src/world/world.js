import { distanceSquared } from "./vec2.js";
import { SpatialHash } from "./spatial-hash.js";

export class World {
    constructor({ spatialCellSize = 20 } = {}) {
        this.time = 0;
        this.entities = new Map();
        this.movingEntities = new Set();
        this.spatial = new SpatialHash(spatialCellSize);
        this.maxEntityRadius = 0;
    }

    addEntity(entity) {
        if (this.entities.has(entity.id)) {
            throw new Error(`Entity already exists: ${entity.id}`);
        }

        if (!entity.position) {
            throw new Error(`Entity ${entity.id} has no position`);
        }

        const stored = structuredClone(entity);
        stored.body ??= { radius: 0.35 };

        const radius = stored.body.radius ?? 0;
        this.maxEntityRadius = Math.max(this.maxEntityRadius, radius);

        this.entities.set(stored.id, stored);
        this.spatial.upsert(stored.id, stored.position, radius);

        if (stored.journey) {
            this.movingEntities.add(stored.id);
        }

        return stored;
    }

    removeEntity(entityId) {
        this.movingEntities.delete(entityId);
        this.spatial.remove(entityId);
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

    markMoving(entityId) {
        if (!this.entities.has(entityId)) {
            throw new Error(`Unknown entity: ${entityId}`);
        }

        this.movingEntities.add(entityId);
    }

    unmarkMoving(entityId) {
        this.movingEntities.delete(entityId);
    }

    queryRadius(position, radius, { excludeId = null, predicate = null } = {}) {
        const candidates = this.spatial.queryRadius(
            position,
            radius + this.maxEntityRadius,
        );
        const result = [];

        for (const entityId of candidates) {
            if (entityId === excludeId) continue;

            const entity = this.entities.get(entityId);
            if (!entity) continue;

            const actualRadius = radius + (entity.body?.radius ?? 0);
            const actualRadiusSquared = actualRadius * actualRadius;

            if (distanceSquared(position, entity.position) > actualRadiusSquared) continue;
            if (predicate && !predicate(entity)) continue;

            result.push(entity);
        }

        return result;
    }
}
