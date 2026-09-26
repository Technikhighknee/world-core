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

function beginJourney(world, entity, destinationNodeId, planned) {
    const route = planned.route;

    if (route.legs.length === 0 && !planned.entryPoint) {
        entity.journey = null;
        world.unmarkMoving(entity.id);
        return true;
    }

    const firstLeg = route.legs[0];
    const firstRoad = firstLeg
        ? planned.navigation.roads.get(firstLeg.roadId)
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

    planned.navigation = navigation;
    return beginJourney(world, entity, destinationNodeId, planned);
}

export function rerouteJourney(world, navigation, entityId, destinationNodeId) {
    return startJourney(world, navigation, entityId, destinationNodeId);
}

export function stopJourney(entity, world = null) {
    entity.journey = null;
    world?.unmarkMoving(entity.id);
}

export function updateMovement(world, navigation, deltaSeconds) {
    const batches = world.getMovementBatches(deltaSeconds);
    const reclassify = [];

    for (const batch of batches) {
        for (const entityId of batch.entityIds) {
            const entity = world.getEntity(entityId);

            if (!entity || !entity.journey) {
                world.unmarkMoving(entityId);
                continue;
            }

            moveEntity(world, navigation, entity, batch.elapsedSeconds);

            if (entity.journey) {
                reclassify.push(entityId);
            }
        }
    }

    for (const entityId of reclassify) {
        world.refreshEntityMovementLod(entityId);
    }
}

function finishJourney(world, entity) {
    entity.journey = null;
    world.unmarkMoving(entity.id);
}

function moveToward(x, y, targetX, targetY, speed, remainingTime) {
    const dx = targetX - x;
    const dy = targetY - y;
    const distanceSquared = dx * dx + dy * dy;

    if (distanceSquared <= EPSILON_SQUARED) {
        return {
            x: targetX,
            y: targetY,
            remainingTime,
            reached: true,
            moved: false,
        };
    }

    const distanceToTarget = Math.sqrt(distanceSquared);
    const secondsToTarget = distanceToTarget / speed;

    if (secondsToTarget <= remainingTime) {
        return {
            x: targetX,
            y: targetY,
            remainingTime: remainingTime - secondsToTarget,
            reached: true,
            moved: true,
        };
    }

    const travelled = speed * remainingTime;
    const scale = travelled / distanceToTarget;

    return {
        x: x + dx * scale,
        y: y + dy * scale,
        remainingTime: 0,
        reached: false,
        moved: true,
    };
}

function moveEntity(world, navigation, entity, deltaSeconds) {
    let remainingTime = deltaSeconds;
    let x = entity.position.x;
    let y = entity.position.y;
    let moved = false;

    while (remainingTime > EPSILON && entity.journey) {
        const journey = entity.journey;

        if (journey.entryPoint) {
            const result = moveToward(
                x,
                y,
                journey.entryPoint.x,
                journey.entryPoint.y,
                entity.mobility.speed,
                remainingTime,
            );

            x = result.x;
            y = result.y;
            remainingTime = result.remainingTime;
            moved ||= result.moved;

            if (result.reached) {
                journey.entryPoint = null;
            } else {
                break;
            }

            continue;
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

        const result = moveToward(
            x,
            y,
            target.x,
            target.y,
            speed,
            remainingTime,
        );

        x = result.x;
        y = result.y;
        remainingTime = result.remainingTime;
        moved ||= result.moved;

        if (result.reached) {
            journey.pointIndex = nextPointIndex(
                journey.pointIndex,
                leg.reversed,
            );
            continue;
        }

        break;
    }

    if (moved) {
        world.setPositionXY(entity.id, x, y);
    }
}
