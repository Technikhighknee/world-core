function sameRange(a, b) {
    return a && b &&
        a.startX === b.startX &&
        a.endX === b.endX &&
        a.startY === b.startY &&
        a.endY === b.endY;
}

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

    #rangeForBounds(minX, minY, maxX, maxY) {
        return {
            startX: this.#coordinate(minX),
            endX: this.#coordinate(maxX),
            startY: this.#coordinate(minY),
            endY: this.#coordinate(maxY),
        };
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
        const nextRange = this.#rangeForBounds(minX, minY, maxX, maxY);
        const currentRange = this.entityRanges.get(entityId);

        if (sameRange(currentRange, nextRange)) {
            return false;
        }

        if (currentRange) {
            this.#removeFromRange(entityId, currentRange);
        }

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

    queryBounds(minX, minY, maxX, maxY) {
        const result = new Set();
        const range = this.#rangeForBounds(minX, minY, maxX, maxY);

        for (let y = range.startY; y <= range.endY; y++) {
            for (let x = range.startX; x <= range.endX; x++) {
                const cell = this.cells.get(this.#key(x, y));
                if (!cell) continue;

                for (const entityId of cell) {
                    result.add(entityId);
                }
            }
        }

        return result;
    }

    queryRadius(position, radius) {
        return this.queryBounds(
            position.x - radius,
            position.y - radius,
            position.x + radius,
            position.y + radius,
        );
    }
}
