import { closestPointOnPolyline } from "./geometry.js";
import { closestPointOnObstacle } from "./obstacle-field.js";

const EPSILON = 1e-9;

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function deterministicSide(a, b) {
    return String(a) < String(b) ? -1 : 1;
}

function currentJourneyLeg(entity) {
    const journey = entity.journey;
    if (!journey) return null;

    return (
        journey.prefixLeg ??
        journey.route.legs[journey.legIndex] ??
        null
    );
}

function headingOnRoad(entity, road) {
    const leg = currentJourneyLeg(entity);

    if (!leg || leg.roadId !== road.id) {
        return null;
    }

    let pointIndex = entity.journey.pointIndex;
    let target = road.points[pointIndex];

    if (!target) {
        pointIndex += leg.reversed ? -1 : 1;
        target = road.points[pointIndex];
    }

    if (!target) return null;

    const dx = target.x - entity.position.x;
    const dy = target.y - entity.position.y;
    const lengthSquared = dx * dx + dy * dy;

    if (lengthSquared <= EPSILON) {
        return {
            reversed: leg.reversed,
            x: null,
            y: null,
        };
    }

    const length = Math.sqrt(lengthSquared);

    return {
        reversed: leg.reversed,
        x: dx / length,
        y: dy / length,
    };
}

function steeringState(entity, road, reversed) {
    entity.simulation ??= {};

    const key =
        `${road.id}:${reversed ? "reverse" : "forward"}`;
    let state = entity.simulation.localSteering;

    if (!state || state.key !== key) {
        state = {
            key,
            offset: 0,
        };

        entity.simulation.localSteering = state;
    }

    return state;
}

function signedOffsetFromCenterline(
    position,
    road,
    normalX,
    normalY,
) {
    const closest = closestPointOnPolyline(
        position,
        road.points,
    );

    if (!closest) return 0;

    return (
        (position.x - closest.point.x) * normalX +
        (position.y - closest.point.y) * normalY
    );
}

function isInsideRoadCorridor(other, road) {
    const closest = closestPointOnPolyline(
        other.position,
        road.points,
    );

    if (!closest) return false;

    return (
        closest.distance <=
        road.width / 2 +
            (other.body?.radius ?? 0)
    );
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

    if (lengthSquared <= EPSILON) return null;

    const length = Math.sqrt(lengthSquared);
    const dirX = dx / length;
    const dirY = dy / length;
    const normalX = -dirY;
    const normalY = dirX;
    const currentLeg = currentJourneyLeg(entity);
    const reversed = Boolean(currentLeg?.reversed);

    const state = steeringState(
        entity,
        road,
        reversed,
    );

    const measuredOffset =
        signedOffsetFromCenterline(
            { x: fromX, y: fromY },
            road,
            normalX,
            normalY,
        );

    if (
        Math.abs(
            measuredOffset - state.offset,
        ) >
        Math.max(
            0.05,
            config.maxLateralSpeed *
                Math.max(deltaSeconds, 0),
        )
    ) {
        state.offset = measuredOffset;
    }

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
    let relevantNeighbors = 0;

    for (const other of neighbors) {
        if (!isInsideRoadCorridor(other, road)) {
            continue;
        }

        relevantNeighbors++;

        const ox = other.position.x - fromX;
        const oy = other.position.y - fromY;
        const centerDistanceSquared =
            ox * ox + oy * oy;
        const otherRadius =
            other.body?.radius ?? 0;
        const desiredSeparation =
            selfRadius +
            otherRadius +
            config.separationGap;

        let centerDistance = 0;
        let along = 0;
        let lateral = 0;

        if (centerDistanceSquared > EPSILON) {
            centerDistance =
                Math.sqrt(centerDistanceSquared);
            along = ox * dirX + oy * dirY;
            lateral =
                ox * normalX +
                oy * normalY;
        }

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

        const otherHeading =
            headingOnRoad(other, road);
        const opposing =
            otherHeading?.x != null &&
            (
                dirX * otherHeading.x +
                dirY * otherHeading.y
            ) < -0.25;

        if (opposing) {
            const distanceWeight =
                Math.max(
                    0,
                    1 -
                        centerDistance /
                            config.neighborRadius,
                );

            lateralForce +=
                (
                    config.trafficSide === "right"
                        ? -1
                        : 1
                ) *
                config.counterflowStrength *
                distanceWeight;

            continue;
        }

        if (
            centerDistance >=
            desiredSeparation
        ) {
            continue;
        }

        const weight =
            centerDistanceSquared <= EPSILON
                ? 1
                : 1 -
                    centerDistance /
                        Math.max(
                            desiredSeparation,
                            EPSILON,
                        );

        let side;

        if (otherHeading?.x != null) {
            side = deterministicSide(
                entity.id,
                other.id,
            );
        } else if (
            Math.abs(lateral) > EPSILON
        ) {
            side = lateral < 0 ? 1 : -1;
        } else {
            side = deterministicSide(
                entity.id,
                other.id,
            );
        }

        lateralForce += side * weight;
    }

    let relevantObstacles = 0;

    if (config.obstacleLookahead > 0) {
        const obstacles =
            world.queryObstaclesRadiusInto(
                {
                    x: fromX,
                    y: fromY,
                },
                config.obstacleLookahead,
            );

        for (const obstacle of obstacles) {
            const closest =
                closestPointOnObstacle(
                    {
                        x: fromX,
                        y: fromY,
                    },
                    obstacle,
                );

            const ox =
                closest.point.x - fromX;
            const oy =
                closest.point.y - fromY;
            const along =
                ox * dirX +
                oy * dirY;
            const lateral =
                ox * normalX +
                oy * normalY;

            if (
                Math.abs(lateral) >
                road.width / 2 +
                    selfRadius +
                    config.obstacleMargin
            ) {
                continue;
            }

            if (
                along <
                -(
                    selfRadius +
                    config.obstacleMargin
                ) ||
                along >
                    config.obstacleLookahead
            ) {
                continue;
            }

            relevantObstacles++;

            const clearance =
                selfRadius +
                config.obstacleMargin;
            const dangerWeight =
                closest.distance <
                clearance
                    ? 1 -
                        closest.distance /
                            Math.max(
                                clearance,
                                EPSILON,
                            )
                    : 0;

            const approachWeight =
                Math.max(
                    0,
                    1 -
                        closest.distance /
                            Math.max(
                                config.obstacleLookahead,
                                EPSILON,
                            ),
                );

            const weight =
                Math.max(
                    dangerWeight,
                    along >= 0
                        ? approachWeight * 0.5
                        : 0,
                );

            if (weight > 0) {
                let side;

                if (
                    Math.abs(lateral) >
                    EPSILON
                ) {
                    side =
                        lateral > 0
                            ? -1
                            : 1;
                } else {
                    side =
                        config.trafficSide ===
                        "right"
                            ? -1
                            : 1;
                }

                lateralForce +=
                    side *
                    config.obstacleStrength *
                    weight;
            }

            if (
                along >= 0 &&
                along <=
                    config.obstacleLookahead
            ) {
                forwardPressure +=
                    approachWeight *
                    config.obstacleForwardPressure;
            }
        }
    }

    const usableHalfWidth = Math.max(
        0,
        road.width / 2 -
            selfRadius -
            config.roadEdgeMargin,
    );

    const maxLateralStep =
        config.maxLateralSpeed *
        Math.max(deltaSeconds, 0);

    let desiredOffset;

    if (Math.abs(lateralForce) > EPSILON) {
        desiredOffset =
            state.offset +
            lateralForce *
                config.separationStrength;
    } else {
        const centerFactor =
            Math.max(
                0,
                1 -
                    config.centeringRate *
                        Math.max(deltaSeconds, 0),
            );

        desiredOffset =
            state.offset * centerFactor;
    }

    desiredOffset = clamp(
        desiredOffset,
        -usableHalfWidth,
        usableHalfWidth,
    );

    const deltaOffset = clamp(
        desiredOffset - state.offset,
        -maxLateralStep,
        maxLateralStep,
    );

    state.offset = clamp(
        state.offset + deltaOffset,
        -usableHalfWidth,
        usableHalfWidth,
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
        lateralOffset: state.offset,
        usableHalfWidth,
        speedMultiplier,
        neighborCount: relevantNeighbors,
        obstacleCount: relevantObstacles,
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

    const closest = closestPointOnPolyline(
        { x, y },
        road.points,
    );

    if (!closest) return { x, y };

    let nextX =
        closest.point.x +
        context.normalX *
            context.lateralOffset;
    let nextY =
        closest.point.y +
        context.normalY *
            context.lateralOffset;

    const offsetDistance =
        Math.abs(context.lateralOffset);

    if (
        offsetDistance <=
        context.usableHalfWidth + EPSILON
    ) {
        return {
            x: nextX,
            y: nextY,
        };
    }

    const clampedOffset = clamp(
        context.lateralOffset,
        -context.usableHalfWidth,
        context.usableHalfWidth,
    );

    nextX =
        closest.point.x +
        context.normalX *
            clampedOffset;
    nextY =
        closest.point.y +
        context.normalY *
            clampedOffset;

    return {
        x: nextX,
        y: nextY,
    };
}
