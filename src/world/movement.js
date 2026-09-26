import { add, distance, mul, normalize, sub } from "./vec2.js";

const EPSILON = 0.000001;

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

    while (remainingTime > EPSILON && entity.journey) {
        const journey = entity.journey;
        const leg = journey.route.legs[journey.legIndex];

        if (!leg) {
            finishJourney(world, entity);
            return;
        }

        const road = navigation.roads.get(leg.roadId);
        if (!road) {
            finishJourney(world, entity);
            return;
        }

        const surfaceMultiplier = entity.mobility.surfaceMultipliers?.[road.surface] ?? 1;
        const speed = entity.mobility.speed * surfaceMultiplier;
        if (!(speed > 0)) return;

        const target = leg.points[journey.pointIndex];

        if (!target) {
            journey.legIndex++;
            journey.pointIndex = 1;

            if (journey.legIndex >= journey.route.legs.length) {
                finishJourney(world, entity);
            }

            continue;
        }

        const distanceToTarget = distance(entity.position, target);

        if (distanceToTarget <= EPSILON) {
            journey.pointIndex++;
            continue;
        }

        const secondsToTarget = distanceToTarget / speed;

        if (secondsToTarget <= remainingTime) {
            world.setPosition(entity.id, target);
            remainingTime -= secondsToTarget;
            journey.pointIndex++;
            continue;
        }

        const direction = normalize(sub(target, entity.position));
        const travelled = speed * remainingTime;
        const nextPosition = add(entity.position, mul(direction, travelled));

        world.setPosition(entity.id, nextPosition);
        remainingTime = 0;
    }
}
