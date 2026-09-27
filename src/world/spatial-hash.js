export class SpatialHash {
    constructor(cellSize = 20) {
        if (!(cellSize > 0)) {
            throw new Error("SpatialHash cellSize must be greater than 0");
        }

        this.cellSize = cellSize;
        this.cells = new Map();
        this.entityRanges = new Map();
    }

    #coordinate(value) {
        return Math.floor(value / this.cellSize);
    }

    #key(x, y) {
        return `${x}:${y}`;
    }

    #addToRange(entityId, range) {
        for (let y = range.startY; y <= range.endY; y++) {
            for (let x = range.startX; x <= range.endX; x++) {
                const key = this.#key(x, y);
                let cell = this.cells.get(key);

                if (!cell) {
                    cell = new Set();
                    this.cells.set(key, cell);
                }

                cell.add(entityId);
            }
        }
    }

    #removeFromRange(entityId, range) {
        for (let y = range.startY; y <= range.endY; y++) {
            for (let x = range.startX; x <= range.endX; x++) {
                const key = this.#key(x, y);
                const cell = this.cells.get(key);
                if (!cell) continue;

                cell.delete(entityId);
                if (cell.size === 0) this.cells.delete(key);
            }
        }
    }

    upsert(entityId, position, radius = 0) {
        return this.upsertBounds(
            entityId,
            position.x - radius,
            position.y - radius,
            position.x + radius,
            position.y + radius,
        );
    }

    upsertBounds(entityId, minX, minY, maxX, maxY) {
        const startX = this.#coordinate(minX);
        const endX = this.#coordinate(maxX);
        const startY = this.#coordinate(minY);
        const endY = this.#coordinate(maxY);
        const currentRange = this.entityRanges.get(entityId);

        if (
            currentRange &&
            currentRange.startX === startX &&
            currentRange.endX === endX &&
            currentRange.startY === startY &&
            currentRange.endY === endY
        ) {
            return false;
        }

        if (currentRange) {
            this.#removeFromRange(entityId, currentRange);
        }

        const nextRange = {
            startX,
            endX,
            startY,
            endY,
        };

        this.#addToRange(entityId, nextRange);
        this.entityRanges.set(entityId, nextRange);
        return true;
    }

    remove(entityId) {
        const range = this.entityRanges.get(entityId);
        if (!range) return false;

        this.#removeFromRange(entityId, range);
        this.entityRanges.delete(entityId);
        return true;
    }

    queryBoundsInto(result, minX, minY, maxX, maxY) {
        result.clear();

        const startX = this.#coordinate(minX);
        const endX = this.#coordinate(maxX);
        const startY = this.#coordinate(minY);
        const endY = this.#coordinate(maxY);

        for (let y = startY; y <= endY; y++) {
            for (let x = startX; x <= endX; x++) {
                const cell = this.cells.get(this.#key(x, y));
                if (!cell) continue;

                for (const entityId of cell) {
                    result.add(entityId);
                }
            }
        }

        return result;
    }

    queryBounds(minX, minY, maxX, maxY) {
        return this.queryBoundsInto(new Set(), minX, minY, maxX, maxY);
    }

    queryRadiusInto(result, position, radius) {
        return this.queryBoundsInto(
            result,
            position.x - radius,
            position.y - radius,
            position.x + radius,
            position.y + radius,
        );
    }

    queryRadius(position, radius) {
        return this.queryRadiusInto(new Set(), position, radius);
    }

    membershipCount() {
        let count = 0;

        for (const cell of this.cells.values()) {
            count += cell.size;
        }

        return count;
    }
}
