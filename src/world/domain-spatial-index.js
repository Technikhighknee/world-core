const CELL_KEY_STRIDE = 67108864;
const CELL_KEY_OFFSET = 33554432;
const EMPTY_MEMBERS = Object.freeze(new Set());

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

/**
 * Sparse spatial hash partitioned by numeric domain handles.
 *
 * Empty domains allocate no cells and no member set. The number of registered
 * world domains therefore has no effect on query/update cost.
 */
export class DomainSpatialIndex {
    constructor(cellSize = 20) {
        if (!(cellSize > 0)) {
            throw new Error("DomainSpatialIndex cellSize must be greater than 0");
        }

        this.cellSize = cellSize;
        this.cellsByDomain = new Map();
        this.membersByDomain = new Map();
        this.entityRanges = new Map();
    }

    #coordinate(value) {
        return Math.floor(value / this.cellSize);
    }

    #domainCells(domainHandle, create = false) {
        let cells = this.cellsByDomain.get(domainHandle);

        if (!cells && create) {
            cells = new Map();
            this.cellsByDomain.set(domainHandle, cells);
        }

        return cells;
    }

    #domainMembers(domainHandle, create = false) {
        let members = this.membersByDomain.get(domainHandle);

        if (!members && create) {
            members = new Set();
            this.membersByDomain.set(domainHandle, members);
        }

        return members;
    }

    #addToRange(entityId, range) {
        const cells = this.#domainCells(range.domainHandle, true);

        for (let y = range.startY; y <= range.endY; y++) {
            for (let x = range.startX; x <= range.endX; x++) {
                addCellMember(cells, cellKey(x, y), entityId);
            }
        }
    }

    #removeFromRange(entityId, range) {
        const cells = this.#domainCells(range.domainHandle);
        if (!cells) return;

        for (let y = range.startY; y <= range.endY; y++) {
            for (let x = range.startX; x <= range.endX; x++) {
                removeCellMember(cells, cellKey(x, y), entityId);
            }
        }

        if (cells.size === 0) {
            this.cellsByDomain.delete(range.domainHandle);
        }
    }

    #setMembership(entityId, previousDomainHandle, nextDomainHandle) {
        if (previousDomainHandle !== nextDomainHandle) {
            const previous = this.#domainMembers(previousDomainHandle);

            if (previous) {
                previous.delete(entityId);

                if (previous.size === 0) {
                    this.membersByDomain.delete(previousDomainHandle);
                }
            }
        }

        this.#domainMembers(nextDomainHandle, true).add(entityId);
    }

    upsertPoint(entityId, domainHandle, position) {
        const x = this.#coordinate(position.x);
        const y = this.#coordinate(position.y);
        const currentRange = this.entityRanges.get(entityId);

        if (
            currentRange &&
            currentRange.domainHandle === domainHandle &&
            currentRange.startX === x &&
            currentRange.endX === x &&
            currentRange.startY === y &&
            currentRange.endY === y
        ) {
            return false;
        }

        if (currentRange) {
            this.#removeFromRange(entityId, currentRange);
        }

        const nextRange = {
            domainHandle,
            startX: x,
            endX: x,
            startY: y,
            endY: y,
        };

        this.#addToRange(entityId, nextRange);
        this.#setMembership(
            entityId,
            currentRange?.domainHandle,
            domainHandle,
        );
        this.entityRanges.set(entityId, nextRange);
        return true;
    }

    upsert(entityId, domainHandle, position, radius = 0) {
        if (!(radius > 0)) {
            return this.upsertPoint(entityId, domainHandle, position);
        }

        return this.upsertBounds(
            entityId,
            domainHandle,
            position.x - radius,
            position.y - radius,
            position.x + radius,
            position.y + radius,
        );
    }

    upsertBounds(entityId, domainHandle, minX, minY, maxX, maxY) {
        const startX = this.#coordinate(minX);
        const endX = this.#coordinate(maxX);
        const startY = this.#coordinate(minY);
        const endY = this.#coordinate(maxY);
        const currentRange = this.entityRanges.get(entityId);

        if (
            currentRange &&
            currentRange.domainHandle === domainHandle &&
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
            domainHandle,
            startX,
            endX,
            startY,
            endY,
        };

        this.#addToRange(entityId, nextRange);
        this.#setMembership(
            entityId,
            currentRange?.domainHandle,
            domainHandle,
        );
        this.entityRanges.set(entityId, nextRange);
        return true;
    }

    remove(entityId) {
        const range = this.entityRanges.get(entityId);
        if (!range) return false;

        this.#removeFromRange(entityId, range);
        this.entityRanges.delete(entityId);

        const members = this.#domainMembers(range.domainHandle);
        if (members) {
            members.delete(entityId);

            if (members.size === 0) {
                this.membersByDomain.delete(range.domainHandle);
            }
        }

        return true;
    }

    queryBoundsInto(
        result,
        domainHandle,
        minX,
        minY,
        maxX,
        maxY,
    ) {
        result.clear();

        const cells = this.#domainCells(domainHandle);
        if (!cells) return result;

        const startX = this.#coordinate(minX);
        const endX = this.#coordinate(maxX);
        const startY = this.#coordinate(minY);
        const endY = this.#coordinate(maxY);

        for (let y = startY; y <= endY; y++) {
            for (let x = startX; x <= endX; x++) {
                addCellMembersToResult(
                    cells.get(cellKey(x, y)),
                    result,
                );
            }
        }

        return result;
    }

    queryBounds(domainHandle, minX, minY, maxX, maxY) {
        return this.queryBoundsInto(
            new Set(),
            domainHandle,
            minX,
            minY,
            maxX,
            maxY,
        );
    }

    queryRadiusInto(result, domainHandle, position, radius) {
        return this.queryBoundsInto(
            result,
            domainHandle,
            position.x - radius,
            position.y - radius,
            position.x + radius,
            position.y + radius,
        );
    }

    queryRadius(domainHandle, position, radius) {
        return this.queryRadiusInto(
            new Set(),
            domainHandle,
            position,
            radius,
        );
    }

    members(domainHandle) {
        return this.membersByDomain.get(domainHandle) ?? EMPTY_MEMBERS;
    }

    cellCount() {
        let count = 0;

        for (const cells of this.cellsByDomain.values()) {
            count += cells.size;
        }

        return count;
    }

    membershipCount() {
        let count = 0;

        for (const cells of this.cellsByDomain.values()) {
            for (const cell of cells.values()) {
                count += cell instanceof Set ? cell.size : 1;
            }
        }

        return count;
    }

    multiOccupancyCellCount() {
        let count = 0;

        for (const cells of this.cellsByDomain.values()) {
            for (const cell of cells.values()) {
                if (cell instanceof Set) count++;
            }
        }

        return count;
    }

    occupiedDomainCount() {
        return this.membersByDomain.size;
    }

    assertInternalConsistency() {
        let indexed = 0;

        for (const [domainHandle, members] of this.membersByDomain) {
            if (members.size === 0) {
                throw new Error(
                    `Empty domain membership retained: ${domainHandle}`,
                );
            }

            for (const entityId of members) {
                const range = this.entityRanges.get(entityId);

                if (!range || range.domainHandle !== domainHandle) {
                    throw new Error(
                        `Domain spatial membership drift: ${String(entityId)}`,
                    );
                }

                indexed++;
            }
        }

        if (indexed !== this.entityRanges.size) {
            throw new Error(
                `Domain spatial range drift: ${indexed} memberships for ${this.entityRanges.size} ranges`,
            );
        }

        return {
            indexedEntities: this.entityRanges.size,
            occupiedDomains: this.occupiedDomainCount(),
            cells: this.cellCount(),
            memberships: this.membershipCount(),
        };
    }
}
