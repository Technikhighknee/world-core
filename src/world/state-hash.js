import { createHash } from "node:crypto";

import {
    serializeWorldCore,
} from "./serialization.js";

function canonicalize(value) {
    if (Array.isArray(value)) {
        return value.map(item =>
            item === undefined
                ? null
                : canonicalize(item),
        );
    }

    if (
        value &&
        typeof value === "object"
    ) {
        const result = {};

        for (
            const key of
            Object.keys(value).sort()
        ) {
            const item = value[key];

            if (item === undefined) {
                continue;
            }

            result[key] =
                canonicalize(item);
        }

        return result;
    }

    if (
        typeof value === "number" &&
        Object.is(value, -0)
    ) {
        return 0;
    }

    return value;
}

function hashCanonical(value) {
    return createHash("sha256")
        .update(
            JSON.stringify(
                canonicalize(value),
            ),
        )
        .digest("hex");
}

function semanticSnapshot(
    world,
    navigation,
) {
    const snapshot =
        serializeWorldCore(
            world,
            navigation,
        );

    const routeById =
        new Map(
            snapshot.routes.map(
                route => {
                    const {
                        id,
                        ...semanticRoute
                    } = route;

                    return [
                        id,
                        semanticRoute,
                    ];
                },
            ),
        );

    const entities =
        snapshot.entities.map(
            serialized => {
                if (
                    !serialized.journey
                ) {
                    return serialized;
                }

                const {
                    routeId,
                    ...journey
                } =
                    serialized.journey;

                return {
                    ...serialized,
                    journey: {
                        ...journey,
                        route:
                            routeById.get(
                                routeId,
                            ),
                    },
                };
            },
        );

    return {
        format: snapshot.format,
        version: snapshot.version,
        navigation:
            snapshot.navigation,
        world: snapshot.world,
        entities,
        entityOrder:
            snapshot.entityOrder,
        movingOrder:
            snapshot.movingOrder,
    };
}

export function computeWorldCoreStateHashes(
    world,
    navigation,
) {
    const snapshot =
        semanticSnapshot(
            world,
            navigation,
        );

    const sections = {
        navigation:
            hashCanonical(
                snapshot.navigation,
            ),
        world:
            hashCanonical(
                snapshot.world,
            ),
        entities:
            hashCanonical({
                entities:
                    snapshot.entities,
                entityOrder:
                    snapshot.entityOrder,
                movingOrder:
                    snapshot.movingOrder,
            }),
    };

    return {
        overall:
            hashCanonical({
                ...snapshot,
            }),
        ...sections,
    };
}

export function computeWorldCoreStateHash(
    world,
    navigation,
) {
    return computeWorldCoreStateHashes(
        world,
        navigation,
    ).overall;
}
