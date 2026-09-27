const EPSILON = 0.000001;
const EPSILON_SQUARED = EPSILON * EPSILON;

function initialPointIndex(road, leg) {
    if (leg.startSegmentIndex != null) {
        return leg.reversed
            ? leg.startSegmentIndex
            : leg.startSegmentIndex + 1;
    }

    return leg.reversed
        ? road.points.length - 2
        : 1;
}

function nextPointIndex(index, reversed) {
    return reversed ? index - 1 : index + 1;
}

function pointIndexIsDone(index, road, reversed) {
    return reversed
        ? index < 0
        : index >= road.points.length;
}

function beginJourney(world, navigation, entity, destinationNodeId, planned) {
    const route = planned.route;

    if (route.legs.length === 0 && !planned.entryPoint) {
        entity.journey = null;
        world.unmarkMoving(entity.id);
        return true;
    }

    const firstLeg = route.legs[0];
    const firstRoad = firstLeg
        ? navigation.roads.get(firstLeg.roadId)
        : null;

    entity.journey = {
        destinationNodeId,
        route,
        entryPoint: planned.entryPoint,
        legIndex: 0,
        pointIndex: firstRoad
            ? initialPointIndex(firstRoad, firstLeg)
            : 0,
    };

    world.markMoving(entity.id);
    return true;
}

export function startJourney(world, navigation, entityId, destinationNodeId) {
    const entity = world.getEntity(entityId);

    if (!entity) {
        throw new Error(`Unknown entity: ${entityId}`);
    }

    if (!entity.mobility) {
        throw new Error(`Entity ${entityId} cannot move`);
    }

    const planned = navigation.findRouteFromPosition(
        entity.position,
        destinationNodeId,
        entity.mobility,
    );

    if (!planned) return false;

    return beginJourney(world, navigation, entity, destinationNodeId, planned);
}

export function rerouteJourney(world, navigation, entityId, destinationNodeId) {
    return startJourney(world, navigation, entityId, destinationNodeId);
}

export function stopJourney(entity, world = null) {
    entity.journey = null;
    world?.unmarkMoving(entity.id);
}

export function updateMovement(world, navigation, deltaSeconds) {
    const reclassify = world.movementReclassifyScratch;
    reclassify.length = 0;

    world.forEachDueMovementBatch(
        deltaSeconds,
        (entityIds, elapsedSeconds) => {
            for (const entityId of entityIds) {
                const entity = world.getEntity(entityId);

                if (!entity || !entity.journey) {
                    world.unmarkMoving(entityId);
                    continue;
                }

                moveEntity(world, navigation, entity, elapsedSeconds);

                if (entity.journey) {
                    reclassify.push(entityId);
                }
            }
        },
    );

    for (let i = 0; i < reclassify.length; i++) {
        world.refreshEntityMovementLod(reclassify[i]);
    }

    reclassify.length = 0;
}

function finishJourney(world, entity) {
    entity.journey = null;
    world.unmarkMoving(entity.id);
}

function advanceToward(
    x,
    y,
    targetX,
    targetY,
    speed,
    remainingTime,
) {
    const dx = targetX - x;
    const dy = targetY - y;
    const distanceSquared = dx * dx + dy * dy;

    if (distanceSquared <= EPSILON_SQUARED) {
        return null;
    }

    const distanceToTarget = Math.sqrt(distanceSquared);
    const secondsToTarget = distanceToTarget / speed;

    if (secondsToTarget <= remainingTime) {
        return [
            targetX,
            targetY,
            remainingTime - secondsToTarget,
            true,
        ];
    }

    const scale = speed * remainingTime / distanceToTarget;

    return [
        x + dx * scale,
        y + dy * scale,
        0,
        false,
    ];
}

function moveEntity(world, navigation, entity, deltaSeconds) {
    let remainingTime = deltaSeconds;
    let x = entity.position.x;
    let y = entity.position.y;
    let moved = false;

    while (remainingTime > EPSILON && entity.journey) {
        const journey = entity.journey;

        if (journey.entryPoint) {
            const targetX = journey.entryPoint.x;
            const targetY = journey.entryPoint.y;
            const dx = targetX - x;
            const dy = targetY - y;
            const distanceSquared = dx * dx + dy * dy;

            if (distanceSquared <= EPSILON_SQUARED) {
                x = targetX;
                y = targetY;
                journey.entryPoint = null;
                continue;
            }

            const distanceToTarget = Math.sqrt(distanceSquared);
            const secondsToTarget =
                distanceToTarget / entity.mobility.speed;

            if (secondsToTarget <= remainingTime) {
                x = targetX;
                y = targetY;
                remainingTime -= secondsToTarget;
                moved = true;
                journey.entryPoint = null;
                continue;
            }

            const scale =
                entity.mobility.speed * remainingTime / distanceToTarget;

            x += dx * scale;
            y += dy * scale;
            moved = true;
            remainingTime = 0;
            break;
        }

        const leg = journey.route.legs[journey.legIndex];

        if (!leg) {
            finishJourney(world, entity);
            break;
        }

        const road = navigation.roads.get(leg.roadId);

        if (!road) {
            finishJourney(world, entity);
            break;
        }

        if (pointIndexIsDone(journey.pointIndex, road, leg.reversed)) {
            journey.legIndex++;

            const nextLeg = journey.route.legs[journey.legIndex];

            if (!nextLeg) {
                finishJourney(world, entity);
                break;
            }

            const nextRoad = navigation.roads.get(nextLeg.roadId);

            if (!nextRoad) {
                finishJourney(world, entity);
                break;
            }

            journey.pointIndex = initialPointIndex(nextRoad, nextLeg);
            continue;
        }

        const surfaceMultiplier =
            entity.mobility.surfaceMultipliers?.[road.surface] ?? 1;
        const speed = entity.mobility.speed * surfaceMultiplier;

        if (!(speed > 0)) break;

        const target = road.points[journey.pointIndex];

        if (!target) {
            finishJourney(world, entity);
            break;
        }

        const dx = target.x - x;
        const dy = target.y - y;
        const distanceSquared = dx * dx + dy * dy;

        if (distanceSquared <= EPSILON_SQUARED) {
            x = target.x;
            y = target.y;
            journey.pointIndex = nextPointIndex(
                journey.pointIndex,
                leg.reversed,
            );
            continue;
        }

        const distanceToTarget = Math.sqrt(distanceSquared);
        const secondsToTarget = distanceToTarget / speed;

        if (secondsToTarget <= remainingTime) {
            x = target.x;
            y = target.y;
            remainingTime -= secondsToTarget;
            moved = true;
            journey.pointIndex = nextPointIndex(
                journey.pointIndex,
                leg.reversed,
            );
            continue;
        }

        const scale = speed * remainingTime / distanceToTarget;

        x += dx * scale;
        y += dy * scale;
        moved = true;
        remainingTime = 0;
    }

    if (moved) {
        world.setPositionXY(entity.id, x, y);
    }
}
