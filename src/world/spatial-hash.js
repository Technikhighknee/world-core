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

function addCellMember(cells, key, id) {
    const cell = cells.get(key);

    if (cell === undefined) {
        cells.set(key, id);
        return;
    }

    if (cell instanceof Set) {
        cell.add(id);
        return;
    }

    if (cell !== id) {
        cells.set(key, new Set([cell, id]));
    }
}

function removeCellMember(cells, key, id) {
    const cell = cells.get(key);

    if (cell === undefined) return;

    if (!(cell instanceof Set)) {
        if (cell === id) cells.delete(key);
        return;
    }

    cell.delete(id);

    if (cell.size === 0) {
        cells.delete(key);
        return;
    }

    if (cell.size === 1) {
        cells.set(key, cell.values().next().value);
    }
}

function addCellMembersToResult(cell, result) {
    if (cell === undefined) return;

    if (cell instanceof Set) {
        for (const id of cell) result.add(id);
        return;
    }

    result.add(cell);
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

    #addToRange(entityId, range) {
        for (let y = range.startY; y <= range.endY; y++) {
            for (let x = range.startX; x <= range.endX; x++) {
                addCellMember(this.cells, cellKey(x, y), entityId);
            }
        }
    }

    #removeFromRange(entityId, range) {
        for (let y = range.startY; y <= range.endY; y++) {
            for (let x = range.startX; x <= range.endX; x++) {
                removeCellMember(this.cells, cellKey(x, y), entityId);
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
                addCellMembersToResult(
                    this.cells.get(cellKey(x, y)),
                    result,
                );
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
            count += cell instanceof Set ? cell.size : 1;
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
