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

    #insertCell(id, x, y) {
        const key = this.#key(x, y);
        let occupied = this.itemCells.get(id);

        if (!occupied) {
            occupied = new Set();
            this.itemCells.set(id, occupied);
        }

        if (occupied.has(key)) return;

        let cell = this.cells.get(key);

        if (!cell) {
            cell = new Set();
            this.cells.set(key, cell);
        }

        cell.add(id);
        occupied.add(key);
    }

    #insertPaddedCell(id, x, y, paddingCells) {
        for (let offsetY = -paddingCells; offsetY <= paddingCells; offsetY++) {
            for (let offsetX = -paddingCells; offsetX <= paddingCells; offsetX++) {
                this.#insertCell(id, x + offsetX, y + offsetY);
            }
        }
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

        for (let y = startY; y <= endY; y++) {
            for (let x = startX; x <= endX; x++) {
                this.#insertCell(id, x, y);
            }
        }
    }

    insertSegment(id, a, b, padding = 0) {
        let x = this.#coordinate(a.x);
        let y = this.#coordinate(a.y);
        const endX = this.#coordinate(b.x);
        const endY = this.#coordinate(b.y);
        const paddingCells = Math.ceil(padding / this.cellSize);

        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const stepX = Math.sign(dx);
        const stepY = Math.sign(dy);

        const tDeltaX = dx === 0 ? Infinity : this.cellSize / Math.abs(dx);
        const tDeltaY = dy === 0 ? Infinity : this.cellSize / Math.abs(dy);

        const nextBoundaryX =
            stepX > 0 ? (x + 1) * this.cellSize : x * this.cellSize;
        const nextBoundaryY =
            stepY > 0 ? (y + 1) * this.cellSize : y * this.cellSize;

        let tMaxX = dx === 0 ? Infinity : (nextBoundaryX - a.x) / dx;
        let tMaxY = dy === 0 ? Infinity : (nextBoundaryY - a.y) / dy;

        while (true) {
            this.#insertPaddedCell(id, x, y, paddingCells);

            if (x === endX && y === endY) break;

            if (tMaxX < tMaxY) {
                x += stepX;
                tMaxX += tDeltaX;
                continue;
            }

            if (tMaxY < tMaxX) {
                y += stepY;
                tMaxY += tDeltaY;
                continue;
            }

            if (stepX !== 0) {
                this.#insertPaddedCell(id, x + stepX, y, paddingCells);
            }

            if (stepY !== 0) {
                this.#insertPaddedCell(id, x, y + stepY, paddingCells);
            }

            x += stepX;
            y += stepY;
            tMaxX += tDeltaX;
            tMaxY += tDeltaY;
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

                for (const id of cell) {
                    result.add(id);
                }
            }
        }

        return result;
    }

    queryBounds(minX, minY, maxX, maxY) {
        return this.queryBoundsInto(new Set(), minX, minY, maxX, maxY);
    }

    queryPointInto(result, position) {
        return this.queryBoundsInto(result, position.x, position.y, position.x, position.y);
    }

    queryPoint(position) {
        return this.queryPointInto(new Set(), position);
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

        for (const occupied of this.itemCells.values()) {
            count += occupied.size;
        }

        return count;
    }
}
