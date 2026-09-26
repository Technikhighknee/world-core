export class SpatialHash {
    constructor(cellSize = 20) {
        this.cellSize = cellSize;

        this.cells = new Map();
        this.entityCells = new Map();
    }

    #coordinate(value) {
        return Math.floor(value / this.cellSize);
    }

    #key(x, y) {
        return `${x}:${y}`;
    }

    #keyForBounds(minX, minY, maxX, maxY) {
        const keys = [];
        
        const startX = this.#coordinate(minX);
        const endX = this.#coordinate(maxX);
        const startY = this.#coordinate(minY);
        const endY = this.#coordinate(maxY);

        for (let y = startY; y <= endY; y++) {
            for (let x = startX; x <= endX; x++) {
                keys.push(this.#key(x, y));
            }
        }

        return keys;
    }

    upsert(entityId, position, radius = 0) {
        this.remove(entityId);
        
        const keys = this.#keyForBounds (
            position.x - radius,
            position.y - radius,
            position.x + radius,
            position.y + radius
        );

        const occupied = new Set();

        for (const key of keys) {
            let cell = this.cells.get(key);

            if (!cell) {
                cell = new Set();
                this.cells.set(key, cell);
            }

            cell.add(entityId);
            occupied.add(key);
        }

        this.entityCells.set(entityId, occupied);
    }

    remove(entityId) {
        const occupied = this.entityCells.get(entityId);
        if (!occupied) return;

        for (const key of occupied) {
            const cell = this.cells.get(key);
            if (!cell) continue;

            cell.delete(entityId);
            if (cell.size === 0) this.cells.delete(key);
        }

        this.entityCells.delete(entityId);
    }

    queryBounds(minX, minY, maxX, maxY) {
        const result = new Set();
        const keys = this.#keyForBounds(minX, minY, maxX, maxY);

        for (const key of keys) {
            const cell = this.cells.get(key);
            if (!cell) continue;

            for (const entityId of cell) {
                result.add(entityId);
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