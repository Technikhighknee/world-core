import { distanceSquared } from "./vec2.js";
import { SpatialHash } from "./spatial-hash.js";

export class World {
    constructor({
        spatialCellSize = 20,
    } = {}) {
        this.time = 0;
        this.entities = new Map();
        this.spatial = new SpatialHash(spatialCellSize);
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

        this.entities.set(stored.id, stored);

        this.spatial.upsert(
            stored.id,
            stored.position,
            stored.body.radius ?? 0,
        );
        
        return stored;
    }

    removeEntity(entityId) {
        this.spatial.remove(entityId);
        return this.entities.delete(entityId)
    }

    getEntity(entityId) {
        return this.entities.get(entityId);
    }

    setPosition(entityId, position) {
        const entity = this.entities.get(entityId);
        if (!entity) {
            throw new Error(`Unknown entity: ${entityId}`);
        }

        entity.position.x = position.x;
        entity.position.y = position.y;

        this.spatial.upsert(
            entity.id,
            entity.position,
            entity.body?.radius ?? 0,
        );
    }

    queryRadius(position, radius, { excludeId = null, predicate = null} = {}) {
        const candidates = this.spatial.queryRadius(position, radius);
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