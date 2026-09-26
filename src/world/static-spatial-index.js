export class StaticSpatialIndex {
    constructor(cellSize = 50) {
        if (!(cellSize > 0)) {
            throw new Error("StaticSpatialIndex cellSize must be greater than 0");
        }

        this.cellSize = cellSize;
        this.cells = new Map();
        this.itemCells = new Map();
    }

    #coordinate(value) {
        return Math.floor(value / this.cellSize);
    }

    #key(x, y) {
        return `${x}:${y}`;
    }

    insertPoint(id, position, padding = 0) {
        this.insertBounds(
            id,
            position.x - padding,
            position.y - padding,
            position.x + padding,
            position.y + padding,
        );
    }

    insertBounds(id, minX, minY, maxX, maxY) {
        const startX = this.#coordinate(minX);
        const endX = this.#coordinate(maxX);
        const startY = this.#coordinate(minY);
        const endY = this.#coordinate(maxY);

        let occupied = this.itemCells.get(id);
        if (!occupied) {
            occupied = new Set();
            this.itemCells.set(id, occupied);
        }

        for (let y = startY; y <= endY; y++) {
            for (let x = startX; x <= endX; x++) {
                const key = this.#key(x, y);
                if (occupied.has(key)) continue;

                let cell = this.cells.get(key);
                if (!cell) {
                    cell = new Set();
                    this.cells.set(key, cell);
                }

                cell.add(id);
                occupied.add(key);
            }
        }
    }

    remove(id) {
        const occupied = this.itemCells.get(id);
        if (!occupied) return false;

        for (const key of occupied) {
            const cell = this.cells.get(key);
            if (!cell) continue;

            cell.delete(id);
            if (cell.size === 0) this.cells.delete(key);
        }

        this.itemCells.delete(id);
        return true;
    }

    queryBounds(minX, minY, maxX, maxY) {
        const result = new Set();
        const startX = this.#coordinate(minX);
        const endX = this.#coordinate(maxX);
        const startY = this.#coordinate(minY);
        const endY = this.#coordinate(maxY);

        for (let y = startY; y <= endY; y++) {
            for (let x = startX; x <= endX; x++) {
                const cell = this.cells.get(this.#key(x, y));
                if (!cell) continue;

                for (const id of cell) result.add(id);
            }
        }

        return result;
    }

    queryPoint(position) {
        return this.queryBounds(position.x, position.y, position.x, position.y);
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
