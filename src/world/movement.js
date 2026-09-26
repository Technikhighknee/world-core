const EPSILON = 0.000001;
const EPSILON_SQUARED = EPSILON * EPSILON;

export function startJourney(world, navigation, entityId, destinationNodeId) {
    const entity = world.getEntity(entityId);

    if (!entity) {
        throw new Error(`Unknown entity: ${entityId}`);
    }

    if (!entity.mobility) {
        throw new Error(`Entity ${entityId} cannot move`);
    }

    const startNode = navigation.nodeAt(entity.position, 0.1);

    if (!startNode) {
        throw new Error(`Entity ${entityId} is not currently at a navigation node`);
    }

    const route = navigation.findRoute(
        startNode.id,
        destinationNodeId,
        entity.mobility,
    );

    if (!route) return false;

    if (route.legs.length === 0) {
        entity.journey = null;
        world.unmarkMoving(entity.id);
        return true;
    }

    entity.journey = {
        destinationNodeId,
        route,
        legIndex: 0,
        pointIndex: 1,
    };

    world.markMoving(entity.id);
    return true;
}

export function stopJourney(entity, world = null) {
    entity.journey = null;
    world?.unmarkMoving(entity.id);
}

export function updateMovement(world, navigation, deltaSeconds) {
    for (const entityId of world.movingEntities) {
        const entity = world.getEntity(entityId);

        if (!entity || !entity.journey) {
            world.unmarkMoving(entityId);
            continue;
        }

        moveEntity(world, navigation, entity, deltaSeconds);
    }
}

function finishJourney(world, entity) {
    entity.journey = null;
    world.unmarkMoving(entity.id);
}

function moveEntity(world, navigation, entity, deltaSeconds) {
    let remainingTime = deltaSeconds;
    let x = entity.position.x;
    let y = entity.position.y;
    let moved = false;

    while (remainingTime > EPSILON && entity.journey) {
        const journey = entity.journey;
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

        const surfaceMultiplier =
            entity.mobility.surfaceMultipliers?.[road.surface] ?? 1;
        const speed = entity.mobility.speed * surfaceMultiplier;

        if (!(speed > 0)) break;

        const target = leg.points[journey.pointIndex];

        if (!target) {
            journey.legIndex++;
            journey.pointIndex = 1;

            if (journey.legIndex >= journey.route.legs.length) {
                finishJourney(world, entity);
            }

            continue;
        }

        const dx = target.x - x;
        const dy = target.y - y;
        const distanceSquared = dx * dx + dy * dy;

        if (distanceSquared <= EPSILON_SQUARED) {
            x = target.x;
            y = target.y;
            journey.pointIndex++;
            continue;
        }

        const distanceToTarget = Math.sqrt(distanceSquared);
        const secondsToTarget = distanceToTarget / speed;

        if (secondsToTarget <= remainingTime) {
            x = target.x;
            y = target.y;
            moved = true;
            remainingTime -= secondsToTarget;
            journey.pointIndex++;
            continue;
        }

        const travelled = speed * remainingTime;
        const scale = travelled / distanceToTarget;

        x += dx * scale;
        y += dy * scale;
        moved = true;
        remainingTime = 0;
    }

    if (moved) {
        world.setPositionXY(entity.id, x, y);
    }
}
