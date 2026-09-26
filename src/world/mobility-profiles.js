export const MOBILITY_PROFILES = Object.freeze({
    pedestrian: Object.freeze({
        profileId: "pedestrian",
        speed: 1.4,
        surfaceMultipliers: Object.freeze({
            street: 1,
            road: 1,
            mud: 0.6,
            trail: 0.8,
        }),
    }),

    cart: Object.freeze({
        profileId: "cart",
        speed: 2.2,
        surfaceMultipliers: Object.freeze({
            street: 0.8,
            road: 1,
            mud: 0.35,
            trail: 0.45,
        }),
    }),

    horse: Object.freeze({
        profileId: "horse",
        speed: 4.5,
        surfaceMultipliers: Object.freeze({
            street: 0.8,
            road: 1,
            mud: 0.6,
            trail: 0.8,
        }),
    }),
});

export function mobilityProfile(id) {
    const profile = MOBILITY_PROFILES[id];

    if (!profile) {
        throw new Error(`Unknown mobility profile: ${id}`);
    }

    return profile;
}
