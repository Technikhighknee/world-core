const CELL_KEY_STRIDE = 67108864;
const CELL_KEY_OFFSET = 33554432;

function cellKey(x, y) {
    const packedX = x + CELL_KEY_OFFSET;
    const packedY = y + CELL_KEY_OFFSET;

    if (
        packedX >= 0 &&
        packedX < CELL_KEY_STRIDE &&
        packedY >= 0 &&
        packedY < CELL_KEY_STRIDE
    ) {
        return packedX * CELL_KEY_STRIDE + packedY;
    }

    return `${x}:${y}`;
}

function hasMembership(value, member) {
    if (value === undefined) return false;
    if (value instanceof Set) return value.has(member);
    return value === member;
}

function addMembership(map, key, member) {
    const value = map.get(key);

    if (value === undefined) {
        map.set(key, member);
        return;
    }

    if (value instanceof Set) {
        value.add(member);
        return;
    }

    if (value !== member) {
        map.set(key, new Set([value, member]));
    }
}

function removeMembership(map, key, member) {
    const value = map.get(key);

    if (value === undefined) return;

    if (!(value instanceof Set)) {
        if (value === member) map.delete(key);
        return;
    }

    value.delete(member);

    if (value.size === 0) {
        map.delete(key);
        return;
    }

    if (value.size === 1) {
        map.set(key, value.values().next().value);
    }
}

function forEachMembership(value, callback) {
    if (value === undefined) return;

    if (value instanceof Set) {
        for (const member of value) callback(member);
        return;
    }

    callback(value);
}

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

    #insertCell(id, x, y) {
        const key = cellKey(x, y);
        const occupied = this.itemCells.get(id);

        if (hasMembership(occupied, key)) return;

        addMembership(this.cells, key, id);
        addMembership(this.itemCells, id, key);
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

            const nextX = x === endX ? Infinity : tMaxX;
            const nextY = y === endY ? Infinity : tMaxY;

            if (nextX < nextY) {
                x += stepX;
                tMaxX += tDeltaX;
                continue;
            }

            if (nextY < nextX) {
                y += stepY;
                tMaxY += tDeltaY;
                continue;
            }

            if (stepX !== 0 && x !== endX) {
                this.#insertPaddedCell(id, x + stepX, y, paddingCells);
                x += stepX;
                tMaxX += tDeltaX;
            }

            if (stepY !== 0 && y !== endY) {
                this.#insertPaddedCell(id, x, y + stepY, paddingCells);
                y += stepY;
                tMaxY += tDeltaY;
            }
        }
    }

    remove(id) {
        const occupied = this.itemCells.get(id);
        if (occupied === undefined) return false;

        forEachMembership(occupied, key => {
            removeMembership(this.cells, key, id);
        });

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
                forEachMembership(
                    this.cells.get(cellKey(x, y)),
                    id => result.add(id),
                );
            }
        }

        return result;
    }

    queryBounds(minX, minY, maxX, maxY) {
        return this.queryBoundsInto(new Set(), minX, minY, maxX, maxY);
    }

    queryPointInto(result, position) {
        return this.queryBoundsInto(
            result,
            position.x,
            position.y,
            position.x,
            position.y,
        );
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
            count += occupied instanceof Set ? occupied.size : 1;
        }

        return count;
    }

    multiOccupancyCellCount() {
        let count = 0;

        for (const cell of this.cells.values()) {
            if (cell instanceof Set) count++;
        }

        return count;
    }
}
