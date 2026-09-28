import { closestPointOnPolyline } from "./geometry.js";

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function deterministicSide(a, b) {
    return String(a) < String(b) ? -1 : 1;
}

export function createLocalSteeringContext(
    world,
    entity,
    road,
    fromX,
    fromY,
    targetX,
    targetY,
    deltaSeconds,
) {
    const config = world.localSteering;

    if (!config?.enabled) return null;
    if (entity.mobility?.localSteering === false) {
        return null;
    }

    const dx = targetX - fromX;
    const dy = targetY - fromY;
    const lengthSquared = dx * dx + dy * dy;

    if (lengthSquared <= 1e-12) return null;

    const length = Math.sqrt(lengthSquared);
    const dirX = dx / length;
    const dirY = dy / length;
    const normalX = -dirY;
    const normalY = dirX;

    const neighbors = world.queryRadiusInto(
        { x: fromX, y: fromY },
        config.neighborRadius,
        world.localSteeringQueryBuffer,
        { excludeId: entity.id },
    );

    const selfRadius = entity.body?.radius ?? 0;
    let lateralForce = 0;
    let occupancyWidth = selfRadius * 2;
    let forwardPressure = 0;

    for (const other of neighbors) {
        const ox = other.position.x - fromX;
        const oy = other.position.y - fromY;
        const centerDistanceSquared =
            ox * ox + oy * oy;

        if (centerDistanceSquared <= 1e-12) {
            lateralForce +=
                deterministicSide(entity.id, other.id);
            occupancyWidth +=
                (other.body?.radius ?? 0) * 2;
            forwardPressure += 1;
            continue;
        }

        const centerDistance =
            Math.sqrt(centerDistanceSquared);
        const otherRadius =
            other.body?.radius ?? 0;
        const desiredSeparation =
            selfRadius +
            otherRadius +
            config.separationGap;

        const along = ox * dirX + oy * dirY;
        const lateral = ox * normalX + oy * normalY;

        if (
            Math.abs(along) <=
            config.neighborRadius
        ) {
            occupancyWidth +=
                otherRadius * 2 +
                config.separationGap;
        }

        if (
            along >= 0 &&
            along <= config.neighborRadius
        ) {
            forwardPressure +=
                Math.max(
                    0,
                    1 -
                    centerDistance /
                        config.neighborRadius,
                );
        }

        if (
            centerDistance >=
            desiredSeparation
        ) {
            continue;
        }

        const weight =
            1 -
            centerDistance /
                Math.max(
                    desiredSeparation,
                    1e-9,
                );

        let side;

        if (Math.abs(lateral) <= 1e-9) {
            side = deterministicSide(
                entity.id,
                other.id,
            );
        } else {
            side = lateral < 0 ? 1 : -1;
        }

        lateralForce += side * weight;
    }

    const usableHalfWidth = Math.max(
        0,
        road.width / 2 -
            selfRadius -
            config.roadEdgeMargin,
    );

    const maxLateralShift = Math.min(
        usableHalfWidth,
        config.maxLateralSpeed *
            deltaSeconds,
    );

    const lateralShift = clamp(
        lateralForce *
            config.separationStrength,
        -maxLateralShift,
        maxLateralShift,
    );

    const localCapacity = Math.max(
        road.width,
        selfRadius * 2 +
            config.separationGap,
    );

    const occupancyRatio =
        occupancyWidth / localCapacity;

    const excessOccupancy = Math.max(
        0,
        occupancyRatio -
            config.congestionThreshold,
    );

    const congestion =
        excessOccupancy +
        forwardPressure *
            config.forwardPressureWeight;

    const speedMultiplier = clamp(
        1 /
            (
                1 +
                congestion *
                    config.congestionStrength
            ),
        config.minSpeedMultiplier,
        1,
    );

    return {
        normalX,
        normalY,
        lateralShift,
        usableHalfWidth,
        speedMultiplier,
        neighborCount: neighbors.length,
        occupancyRatio,
    };
}

export function applyLocalSteering(
    entity,
    road,
    x,
    y,
    context,
) {
    if (!context) return { x, y };

    let nextX =
        x +
        context.normalX *
            context.lateralShift;
    let nextY =
        y +
        context.normalY *
            context.lateralShift;

    const closest = closestPointOnPolyline(
        { x: nextX, y: nextY },
        road.points,
    );

    if (
        !closest ||
        closest.distance <=
            context.usableHalfWidth
    ) {
        return {
            x: nextX,
            y: nextY,
        };
    }

    const dx = nextX - closest.point.x;
    const dy = nextY - closest.point.y;
    const distance =
        Math.sqrt(dx * dx + dy * dy);

    if (distance <= 1e-12) {
        return {
            x: closest.point.x,
            y: closest.point.y,
        };
    }

    const scale =
        context.usableHalfWidth /
        distance;

    nextX =
        closest.point.x +
        dx * scale;
    nextY =
        closest.point.y +
        dy * scale;

    return {
        x: nextX,
        y: nextY,
    };
}
