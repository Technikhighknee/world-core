import { closestPointOnSegment } from "./geometry.js";
import { StaticSpatialIndex } from "./static-spatial-index.js";

const EPSILON = 1e-9;

function sortedUnique(values) {
    return [...new Set(values ?? [])].sort();
}

function validatePoint(point, label) {
    if (
        !point ||
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y)
    ) {
        throw new Error(
            `${label} must contain finite x/y coordinates`,
        );
    }
}

function normalizeObstacle(input) {
    if (!input?.id) {
        throw new Error("Obstacle id is required");
    }

    const common = {
        id: input.id,
        type: input.type,
        enabled: input.enabled ?? true,
        temporary: input.temporary ?? false,
        tags: sortedUnique(input.tags),
        version: input.version ?? 1,
    };

    if (input.type === "circle") {
        validatePoint(
            input.center,
            "Circle obstacle center",
        );

        if (!(input.radius >= 0)) {
            throw new Error(
                "Circle obstacle radius must be greater than or equal to 0",
            );
        }

        return {
            ...common,
            center: { ...input.center },
            radius: input.radius,
        };
    }

    if (input.type === "aabb") {
        const {
            minX,
            minY,
            maxX,
            maxY,
        } = input;

        if (
            ![
                minX,
                minY,
                maxX,
                maxY,
            ].every(Number.isFinite) ||
            minX > maxX ||
            minY > maxY
        ) {
            throw new Error(
                "AABB obstacle bounds are invalid",
            );
        }

        return {
            ...common,
            minX,
            minY,
            maxX,
            maxY,
        };
    }

    if (input.type === "segment") {
        validatePoint(
            input.a,
            "Segment obstacle a",
        );
        validatePoint(
            input.b,
            "Segment obstacle b",
        );

        const radius =
            input.radius ?? 0;

        if (!(radius >= 0)) {
            throw new Error(
                "Segment obstacle radius must be greater than or equal to 0",
            );
        }

        return {
            ...common,
            a: { ...input.a },
            b: { ...input.b },
            radius,
        };
    }

    throw new Error(
        `Unsupported obstacle type: ${input.type}`,
    );
}

function boundsFor(obstacle) {
    if (obstacle.type === "circle") {
        return {
            minX:
                obstacle.center.x -
                obstacle.radius,
            minY:
                obstacle.center.y -
                obstacle.radius,
            maxX:
                obstacle.center.x +
                obstacle.radius,
            maxY:
                obstacle.center.y +
                obstacle.radius,
        };
    }

    if (obstacle.type === "aabb") {
        return {
            minX: obstacle.minX,
            minY: obstacle.minY,
            maxX: obstacle.maxX,
            maxY: obstacle.maxY,
        };
    }

    return {
        minX:
            Math.min(
                obstacle.a.x,
                obstacle.b.x,
            ) - obstacle.radius,
        minY:
            Math.min(
                obstacle.a.y,
                obstacle.b.y,
            ) - obstacle.radius,
        maxX:
            Math.max(
                obstacle.a.x,
                obstacle.b.x,
            ) + obstacle.radius,
        maxY:
            Math.max(
                obstacle.a.y,
                obstacle.b.y,
            ) + obstacle.radius,
    };
}

function closestCircle(point, obstacle) {
    const dx =
        point.x - obstacle.center.x;
    const dy =
        point.y - obstacle.center.y;
    const centerDistance =
        Math.sqrt(dx * dx + dy * dy);

    if (centerDistance <= EPSILON) {
        return {
            point: {
                x:
                    obstacle.center.x +
                    obstacle.radius,
                y: obstacle.center.y,
            },
            distance: 0,
            inside:
                obstacle.radius > 0,
        };
    }

    const scale =
        obstacle.radius /
        centerDistance;

    return {
        point: {
            x:
                obstacle.center.x +
                dx * scale,
            y:
                obstacle.center.y +
                dy * scale,
        },
        distance:
            Math.max(
                0,
                centerDistance -
                    obstacle.radius,
            ),
        inside:
            centerDistance <
            obstacle.radius,
    };
}

function closestAabb(point, obstacle) {
    const inside =
        point.x >= obstacle.minX &&
        point.x <= obstacle.maxX &&
        point.y >= obstacle.minY &&
        point.y <= obstacle.maxY;

    if (!inside) {
        const closest = {
            x: Math.max(
                obstacle.minX,
                Math.min(
                    obstacle.maxX,
                    point.x,
                ),
            ),
            y: Math.max(
                obstacle.minY,
                Math.min(
                    obstacle.maxY,
                    point.y,
                ),
            ),
        };

        const dx =
            point.x - closest.x;
        const dy =
            point.y - closest.y;

        return {
            point: closest,
            distance:
                Math.sqrt(
                    dx * dx + dy * dy,
                ),
            inside: false,
        };
    }

    const distances = [
        {
            value:
                point.x -
                obstacle.minX,
            point: {
                x: obstacle.minX,
                y: point.y,
            },
        },
        {
            value:
                obstacle.maxX -
                point.x,
            point: {
                x: obstacle.maxX,
                y: point.y,
            },
        },
        {
            value:
                point.y -
                obstacle.minY,
            point: {
                x: point.x,
                y: obstacle.minY,
            },
        },
        {
            value:
                obstacle.maxY -
                point.y,
            point: {
                x: point.x,
                y: obstacle.maxY,
            },
        },
    ];

    distances.sort(
        (a, b) =>
            a.value - b.value,
    );

    return {
        point: distances[0].point,
        distance: 0,
        inside: true,
    };
}

function closestSegment(point, obstacle) {
    const centerline =
        closestPointOnSegment(
            point,
            obstacle.a,
            obstacle.b,
        );

    const dx =
        point.x -
        centerline.point.x;
    const dy =
        point.y -
        centerline.point.y;
    const centerDistance =
        centerline.distance;

    if (centerDistance <= EPSILON) {
        const sx =
            obstacle.b.x -
            obstacle.a.x;
        const sy =
            obstacle.b.y -
            obstacle.a.y;
        const length =
            Math.sqrt(
                sx * sx + sy * sy,
            ) || 1;

        return {
            point: {
                x:
                    centerline.point.x -
                    sy /
                        length *
                        obstacle.radius,
                y:
                    centerline.point.y +
                    sx /
                        length *
                        obstacle.radius,
            },
            distance: 0,
            inside:
                obstacle.radius > 0,
        };
    }

    const scale =
        obstacle.radius /
        centerDistance;

    return {
        point: {
            x:
                centerline.point.x +
                dx * scale,
            y:
                centerline.point.y +
                dy * scale,
        },
        distance:
            Math.max(
                0,
                centerDistance -
                    obstacle.radius,
            ),
        inside:
            centerDistance <
            obstacle.radius,
    };
}

export function closestPointOnObstacle(
    point,
    obstacle,
) {
    if (obstacle.type === "circle") {
        return closestCircle(
            point,
            obstacle,
        );
    }

    if (obstacle.type === "aabb") {
        return closestAabb(
            point,
            obstacle,
        );
    }

    if (obstacle.type === "segment") {
        return closestSegment(
            point,
            obstacle,
        );
    }

    throw new Error(
        `Unsupported obstacle type: ${obstacle.type}`,
    );
}

export class ObstacleField {
    constructor(cellSize = 20) {
        this.index =
            new StaticSpatialIndex(
                cellSize,
            );
        this.obstacles = new Map();
        this.queryScratch = new Set();
    }

    #indexObstacle(obstacle) {
        const bounds =
            boundsFor(obstacle);

        this.index.insertBounds(
            obstacle.id,
            bounds.minX,
            bounds.minY,
            bounds.maxX,
            bounds.maxY,
        );
    }

    add(input) {
        if (
            this.obstacles.has(input.id)
        ) {
            throw new Error(
                `Obstacle already exists: ${input.id}`,
            );
        }

        const obstacle =
            normalizeObstacle(input);

        this.obstacles.set(
            obstacle.id,
            obstacle,
        );
        this.#indexObstacle(obstacle);

        return obstacle;
    }

    remove(obstacleId) {
        if (
            !this.obstacles.has(
                obstacleId,
            )
        ) {
            return false;
        }

        this.index.remove(obstacleId);
        this.obstacles.delete(
            obstacleId,
        );
        return true;
    }

    setEnabled(
        obstacleId,
        enabled,
    ) {
        const obstacle =
            this.obstacles.get(
                obstacleId,
            );

        if (!obstacle) {
            throw new Error(
                `Unknown obstacle: ${obstacleId}`,
            );
        }

        enabled = Boolean(enabled);

        if (
            obstacle.enabled ===
            enabled
        ) {
            return false;
        }

        obstacle.enabled = enabled;
        obstacle.version++;
        return true;
    }

    replace(
        obstacleId,
        patch,
    ) {
        const previous =
            this.obstacles.get(
                obstacleId,
            );

        if (!previous) {
            throw new Error(
                `Unknown obstacle: ${obstacleId}`,
            );
        }

        const next =
            normalizeObstacle({
                ...previous,
                ...patch,
                id: obstacleId,
                version:
                    previous.version + 1,
            });

        this.index.remove(
            obstacleId,
        );
        this.obstacles.set(
            obstacleId,
            next,
        );
        this.#indexObstacle(next);

        return next;
    }

    queryRadiusInto(
        results,
        position,
        radius,
        candidates =
            this.queryScratch,
        {
            includeDisabled = false,
            predicate = null,
        } = {},
    ) {
        if (!(radius >= 0)) {
            throw new Error(
                "Obstacle query radius must be greater than or equal to 0",
            );
        }

        results.length = 0;

        this.index.queryRadiusInto(
            candidates,
            position,
            radius,
        );

        for (const obstacleId of candidates) {
            const obstacle =
                this.obstacles.get(
                    obstacleId,
                );

            if (!obstacle) continue;
            if (
                !includeDisabled &&
                !obstacle.enabled
            ) {
                continue;
            }

            const closest =
                closestPointOnObstacle(
                    position,
                    obstacle,
                );

            if (
                closest.distance >
                radius
            ) {
                continue;
            }

            if (
                predicate &&
                !predicate(obstacle)
            ) {
                continue;
            }

            results.push(obstacle);
        }

        results.sort(
            (a, b) =>
                String(a.id)
                    .localeCompare(
                        String(b.id),
                    ),
        );

        return results;
    }

    getDiagnostics() {
        return {
            obstacleCount:
                this.obstacles.size,
            indexedObstacleCount:
                this.index.itemCells.size,
            indexMemberships:
                this.index.membershipCount(),
        };
    }

    assertInternalConsistency() {
        const diagnostics =
            this.getDiagnostics();

        if (
            diagnostics.obstacleCount !==
            diagnostics.indexedObstacleCount
        ) {
            throw new Error(
                `Obstacle index drift: ${diagnostics.indexedObstacleCount} indexed for ${diagnostics.obstacleCount} obstacles`,
            );
        }

        for (
            const obstacleId of
            this.index.itemCells.keys()
        ) {
            if (
                !this.obstacles.has(
                    obstacleId,
                )
            ) {
                throw new Error(
                    `Obstacle index contains stale id: ${obstacleId}`,
                );
            }
        }

        for (
            const [obstacleId, obstacle] of
            this.obstacles
        ) {
            if (
                !this.index.itemCells.has(
                    obstacleId,
                )
            ) {
                throw new Error(
                    `Obstacle missing from index: ${obstacleId}`,
                );
            }

            normalizeObstacle(obstacle);
        }

        return diagnostics;
    }
}
