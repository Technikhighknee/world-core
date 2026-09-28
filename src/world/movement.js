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
    const prefixLeg = planned.prefixLeg ?? null;

    if (route.legs.length === 0 && !prefixLeg && !planned.entryPoint) {
        entity.journey = null;
        world.unmarkMoving(entity.id);
        return true;
    }

    const firstLeg = prefixLeg ?? route.legs[0];
    const firstRoad = firstLeg
        ? navigation.roads.get(firstLeg.roadId)
        : null;

    entity.journey = {
        destinationNodeId,
        route,
        prefixLeg,
        entryPoint: planned.entryPoint,
        legIndex: 0,
        pointIndex: firstRoad
            ? initialPointIndex(firstRoad, firstLeg)
            : 0,
        validatedGraphRevision:
            navigation.graphRevision,
    };

    world.markMoving(entity.id);
    return true;
}

export function startJourney(
    world,
    navigation,
    entityId,
    destinationNodeId,
    options = {},
) {
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
        options,
    );

    if (!planned) return false;

    return beginJourney(
        world,
        navigation,
        entity,
        destinationNodeId,
        planned,
    );
}

export function rerouteJourney(
    world,
    navigation,
    entityId,
    destinationNodeId,
    options = {},
) {
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
        options,
    );

    if (!planned) return false;

    return beginJourney(
        world,
        navigation,
        entity,
        destinationNodeId,
        planned,
    );
}

export function stopJourney(entity, world = null) {
    entity.journey = null;
    world?.unmarkMoving(entity.id);
}

export function updateMovement(world, navigation, deltaSeconds) {
    const refreshDynamicLod = world.hasDynamicMovementLod();
    const reclassify = world.movementReclassifyScratch;

    if (refreshDynamicLod) {
        reclassify.length = 0;
    }

    world.forEachDueMovementBatch(
        deltaSeconds,
        (entities, elapsedSeconds, skipEntityIds) => {
            for (const entity of entities) {
                const entityId = entity.id;

                if (skipEntityIds?.has(entityId)) continue;

                if (!entity.journey) {
                    world.unmarkMoving(entityId);
                    continue;
                }

                const journey = entity.journey;

                if (
                    journey.validatedGraphRevision !==
                    navigation.graphRevision
                ) {
                    const prefixCurrent =
                        !journey.prefixLeg ||
                        navigation.isRouteLegCurrent(
                            journey.prefixLeg,
                            entity.mobility,
                        );

                    const routeCurrent =
                        navigation.isRouteCurrent(
                            journey.route,
                            entity.mobility,
                            journey.legIndex,
                        );

                    if (
                        !prefixCurrent ||
                        !routeCurrent
                    ) {
                        if (
                            !replanInvalidJourney(
                                world,
                                navigation,
                                entity,
                            )
                        ) {
                            continue;
                        }
                    } else {
                        journey.validatedGraphRevision =
                            navigation.graphRevision;
                    }
                }

                moveEntity(world, navigation, entity, elapsedSeconds);

                if (
                    refreshDynamicLod &&
                    entity.journey &&
                    entity.simulation?.movementInterval == null
                ) {
                    reclassify.push(entityId);
                }
            }
        },
    );

    if (!refreshDynamicLod) return;

    for (let i = 0; i < reclassify.length; i++) {
        world.refreshEntityMovementLod(reclassify[i]);
    }

    reclassify.length = 0;
}

function finishJourney(world, entity) {
    entity.journey = null;
    world.unmarkMoving(entity.id);
}

function invalidateJourney(world, entity, reason) {
    const destinationNodeId =
        entity.journey?.destinationNodeId ?? null;

    entity.journey = null;
    entity.lastJourneyFailure = {
        destinationNodeId,
        reason,
        time: world.time,
    };

    world.unmarkMoving(entity.id);
}

function replanInvalidJourney(
    world,
    navigation,
    entity,
) {
    const destinationNodeId =
        entity.journey?.destinationNodeId;

    if (!destinationNodeId) {
        invalidateJourney(
            world,
            entity,
            "missing-destination",
        );
        return false;
    }

    const entryMaxDistance =
        entity.mobility.navigationEntryMaxDistance ??
        0;

    const planned = navigation.findRouteFromPosition(
        entity.position,
        destinationNodeId,
        entity.mobility,
        { entryMaxDistance },
    );

    if (!planned) {
        invalidateJourney(
            world,
            entity,
            "route-invalidated",
        );
        return false;
    }

    beginJourney(
        world,
        navigation,
        entity,
        destinationNodeId,
        planned,
    );

    return true;
}

function advanceLeg(world, navigation, entity, journey) {
    if (journey.prefixLeg) {
        journey.prefixLeg = null;

        const firstRouteLeg = journey.route.legs[journey.legIndex];

        if (!firstRouteLeg) {
            finishJourney(world, entity);
            return false;
        }

        const firstRouteRoad = navigation.roads.get(firstRouteLeg.roadId);

        if (!firstRouteRoad) {
            finishJourney(world, entity);
            return false;
        }

        journey.pointIndex = initialPointIndex(
            firstRouteRoad,
            firstRouteLeg,
        );

        return true;
    }

    journey.legIndex++;

    const nextLeg = journey.route.legs[journey.legIndex];

    if (!nextLeg) {
        finishJourney(world, entity);
        return false;
    }

    const nextRoad = navigation.roads.get(nextLeg.roadId);

    if (!nextRoad) {
        finishJourney(world, entity);
        return false;
    }

    journey.pointIndex = initialPointIndex(nextRoad, nextLeg);
    return true;
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

        const leg = journey.prefixLeg ??
            journey.route.legs[journey.legIndex];

        if (!leg) {
            finishJourney(world, entity);
            break;
        }

        if (
            !navigation.isRouteLegCurrent(
                leg,
                entity.mobility,
            )
        ) {
            if (
                !replanInvalidJourney(
                    world,
                    navigation,
                    entity,
                )
            ) {
                break;
            }

            continue;
        }

        const road = navigation.roads.get(leg.roadId);

        if (!road) {
            invalidateJourney(
                world,
                entity,
                "road-missing",
            );
            break;
        }

        if (pointIndexIsDone(journey.pointIndex, road, leg.reversed)) {
            if (!advanceLeg(world, navigation, entity, journey)) {
                break;
            }

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
        world.setEntityPositionXY(entity, x, y);
    }
}
