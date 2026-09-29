import assert from "node:assert/strict";
import test from "node:test";

import {
    DEFAULT_WORLD_DOMAIN_ID,
    Navigation,
    NavigationRegistry,
    World,
    startJourney,
    stepSimulation,
    deserializeWorldCore,
    serializeWorldCore,
    validateWorldCoreSnapshot,
} from "../src/index.js";

test("world domains default cleanly and isolate identical local coordinates", () => {
    const world = new World();

    assert.equal(
        world.getDomain(DEFAULT_WORLD_DOMAIN_ID)?.handle,
        0,
    );

    world.addDomain({ id: "tavern-a" });
    world.addDomain({ id: "tavern-b" });

    world.addEntity({
        id: "outside",
        position: { x: 5, y: 5 },
    });
    world.addEntity({
        id: "a",
        domainId: "tavern-a",
        position: { x: 5, y: 5 },
    });
    world.addEntity({
        id: "b",
        domainId: "tavern-b",
        position: { x: 5, y: 5 },
    });

    assert.deepEqual(
        world.queryRadius(
            { x: 5, y: 5 },
            1,
        ).map(entity => entity.id),
        ["outside"],
    );

    assert.deepEqual(
        world.queryRadius(
            { x: 5, y: 5 },
            1,
            { domainId: "tavern-a" },
        ).map(entity => entity.id),
        ["a"],
    );

    assert.deepEqual(
        world.queryRadius(
            { x: 5, y: 5 },
            1,
            {
                excludeId: "a",
            },
        ).map(entity => entity.id),
        [],
    );

    assert.equal(
        world.queryNearest(
            { x: 5, y: 5 },
            {
                domainId: "tavern-b",
            },
        )?.entity.id,
        "b",
    );

    world.assertInternalConsistency();
});

test("domain transfer atomically moves spatial membership and domain accounting", () => {
    const world = new World({
        captureEvents: true,
    });

    world.addDomain({
        id: "tavern",
    });

    const entity =
        world.addEntity({
            id: "hans",
            position: { x: 10, y: 10 },
        });

    world.transferEntity(
        "hans",
        {
            domainId: "tavern",
            position: { x: 2, y: 3 },
        },
    );

    assert.equal(
        entity.domainId,
        "tavern",
    );
    assert.deepEqual(
        entity.position,
        { x: 2, y: 3 },
    );
    assert.equal(
        world.getDomain(
            DEFAULT_WORLD_DOMAIN_ID,
        ).entityCount,
        0,
    );
    assert.equal(
        world.getDomain("tavern")
            .entityCount,
        1,
    );

    assert.deepEqual(
        world.queryRadius(
            { x: 10, y: 10 },
            1,
        ),
        [],
    );

    assert.deepEqual(
        world.queryRadius(
            { x: 2, y: 3 },
            1,
            {
                domainId:
                    "tavern",
            },
        ).map(candidate =>
            candidate.id),
        ["hans"],
    );

    assert.deepEqual(
        world.peekEvents()
            .filter(event =>
                event.type ===
                "entityDomainTransferred")
            .map(event => ({
                entityId:
                    event.entityId,
                from:
                    event.fromDomainId,
                to:
                    event.toDomainId,
            })),
        [
            {
                entityId: "hans",
                from:
                    DEFAULT_WORLD_DOMAIN_ID,
                to: "tavern",
            },
        ],
    );

    world.assertInternalConsistency();
});

test("non-empty domains cannot be removed and unknown domains are rejected", () => {
    const world = new World();

    world.addDomain({
        id: "house",
    });

    assert.throws(
        () =>
            world.addEntity({
                id: "bad",
                domainId: "missing",
                position: {
                    x: 0,
                    y: 0,
                },
            }),
        /Unknown world domain/,
    );

    world.addEntity({
        id: "resident",
        domainId: "house",
        position: {
            x: 0,
            y: 0,
        },
    });

    assert.throws(
        () =>
            world.removeDomain(
                "house",
            ),
        /non-empty world domain/,
    );

    world.removeEntity(
        "resident",
    );

    assert.equal(
        world.removeDomain(
            "house",
        ),
        true,
    );

    assert.throws(
        () =>
            world.removeDomain(
                DEFAULT_WORLD_DOMAIN_ID,
            ),
        /default world domain/,
    );
});

test("empty domains allocate no spatial cells or occupied-domain state", () => {
    const world = new World();

    for (
        let index = 0;
        index < 10_000;
        index++
    ) {
        world.addDomain({
            id: `interior-${index}`,
        });
    }

    const diagnostics =
        world.getDiagnostics();

    assert.equal(
        diagnostics.domainCount,
        10_001,
    );
    assert.equal(
        diagnostics.entityCount,
        0,
    );
    assert.equal(
        diagnostics.spatialCellCount,
        0,
    );
    assert.equal(
        diagnostics.spatialMemberships,
        0,
    );
    assert.equal(
        diagnostics.occupiedSpatialDomainCount,
        0,
    );

    world.assertInternalConsistency();
});

test("world domains round-trip through v1 snapshots without duplicating topology state", () => {
    const world = new World();
    const navigation =
        new Navigation();

    world.addDomain({
        id: "house-a",
    });
    world.addDomain({
        id: "house-b",
    });

    world.addEntity({
        id: "hans",
        domainId: "house-b",
        position: {
            x: 4,
            y: 9,
        },
    });

    const snapshot =
        serializeWorldCore(
            world,
            navigation,
        );

    assert.equal(
        snapshot.version,
        1,
    );
    assert.deepEqual(
        snapshot.world.domains,
        [
            {
                id:
                    DEFAULT_WORLD_DOMAIN_ID,
            },
            {
                id: "house-a",
            },
            {
                id: "house-b",
            },
        ],
    );

    assert.equal(
        validateWorldCoreSnapshot(
            snapshot,
        ),
        true,
    );

    const restored =
        deserializeWorldCore(
            snapshot,
        );

    assert.equal(
        restored.world
            .getEntity("hans")
            .domainId,
        "house-b",
    );
    assert.equal(
        restored.world
            .getDomain("house-a")
            .entityCount,
        0,
    );
    assert.equal(
        restored.world
            .getDomain("house-b")
            .entityCount,
        1,
    );

    restored.world
        .assertInternalConsistency();
});

test("snapshot validation rejects entity references to missing domains", () => {
    const world = new World();
    const navigation =
        new Navigation();

    world.addEntity({
        id: "hans",
        position: {
            x: 0,
            y: 0,
        },
    });

    const snapshot =
        serializeWorldCore(
            world,
            navigation,
        );

    snapshot.entities[0]
        .entity.domainId =
        "missing";

    assert.throws(
        () =>
            validateWorldCoreSnapshot(
                snapshot,
            ),
        /references missing world domain/,
    );
});


test("many domains can share one navigation topology without graph copies", () => {
    const world = new World();
    const topology =
        new Navigation();
    const navigation =
        new NavigationRegistry();

    topology.addNode({
        id: "west",
        x: 0,
        y: 0,
    });
    topology.addNode({
        id: "east",
        x: 10,
        y: 0,
    });
    topology.addRoad({
        id: "hall",
        from: "west",
        to: "east",
        width: 3,
    });

    navigation.registerTopology(
        "small-house",
        topology,
    );

    for (
        let index = 0;
        index < 10_000;
        index++
    ) {
        const domainId =
            `house-${index}`;

        world.addDomain({
            id: domainId,
        });

        navigation.bindDomain(
            domainId,
            "small-house",
        );
    }

    assert.equal(
        navigation.getDiagnostics()
            .topologyCount,
        1,
    );
    assert.equal(
        navigation.getDiagnostics()
            .boundDomainCount,
        10_000,
    );
    assert.equal(
        navigation.navigationForDomain(
            "house-1",
        ),
        topology,
    );
    assert.equal(
        navigation.navigationForDomain(
            "house-9999",
        ),
        topology,
    );

    navigation.assertInternalConsistency();
    world.assertInternalConsistency();
});

test("movement resolves different shared topologies per world domain", async () => {
    const {
        startJourney,
        stepSimulation,
    } = await import(
        "../src/index.js"
    );

    const world = new World();
    const registry =
        new NavigationRegistry();

    world.addDomain({
        id: "short-house",
    });
    world.addDomain({
        id: "long-house",
    });

    const short =
        new Navigation();
    short.addNode({
        id: "start",
        x: 0,
        y: 0,
    });
    short.addNode({
        id: "end",
        x: 2,
        y: 0,
    });
    short.addRoad({
        id: "hall",
        from: "start",
        to: "end",
    });

    const long =
        new Navigation();
    long.addNode({
        id: "start",
        x: 0,
        y: 0,
    });
    long.addNode({
        id: "end",
        x: 20,
        y: 0,
    });
    long.addRoad({
        id: "hall",
        from: "start",
        to: "end",
    });

    registry.registerTopology(
        "short",
        short,
    );
    registry.registerTopology(
        "long",
        long,
    );
    registry.bindDomain(
        "short-house",
        "short",
    );
    registry.bindDomain(
        "long-house",
        "long",
    );

    world.addEntity({
        id: "short-walker",
        domainId: "short-house",
        position: {
            x: 0,
            y: 0,
        },
        mobility: {
            speed: 1,
        },
    });
    world.addEntity({
        id: "long-walker",
        domainId: "long-house",
        position: {
            x: 0,
            y: 0,
        },
        mobility: {
            speed: 1,
        },
    });

    assert.equal(
        startJourney(
            world,
            registry,
            "short-walker",
            "end",
        ),
        true,
    );
    assert.equal(
        startJourney(
            world,
            registry,
            "long-walker",
            "end",
        ),
        true,
    );

    stepSimulation(
        world,
        registry,
        3,
    );

    assert.equal(
        world.getEntity(
            "short-walker",
        ).journey,
        null,
    );
    assert.ok(
        world.getEntity(
            "long-walker",
        ).journey,
    );
    assert.equal(
        world.getEntity(
            "short-walker",
        ).position.x,
        2,
    );
    assert.equal(
        world.getEntity(
            "long-walker",
        ).position.x,
        3,
    );

    world.assertInternalConsistency();
    registry.assertInternalConsistency();
});

test("shared topology mutation is visible to every bound domain", () => {
    const topology =
        new Navigation();
    const registry =
        new NavigationRegistry();

    topology.addNode({
        id: "a",
        x: 0,
        y: 0,
    });
    topology.addNode({
        id: "b",
        x: 1,
        y: 0,
    });
    topology.addRoad({
        id: "doorway",
        from: "a",
        to: "b",
    });

    registry.registerTopology(
        "room",
        topology,
    );
    registry.bindDomain(
        "room-1",
        "room",
    );
    registry.bindDomain(
        "room-2",
        "room",
    );

    topology.setRoadEnabled(
        "doorway",
        false,
    );

    for (
        const domainId of
        ["room-1", "room-2"]
    ) {
        assert.equal(
            registry
                .navigationForDomain(
                    domainId,
                )
                .findRoute(
                    "a",
                    "b",
                    { speed: 1 },
                ),
            null,
        );
    }
});


test("dynamic obstacles are isolated per domain and allocated sparsely", () => {
    const world = new World();

    world.addDomain({
        id: "cellar-a",
    });
    world.addDomain({
        id: "cellar-b",
    });

    world.addObstacle(
        {
            id: "barrel-a",
            type: "circle",
            center: {
                x: 5,
                y: 5,
            },
            radius: 1,
        },
        {
            domainId:
                "cellar-a",
        },
    );

    assert.deepEqual(
        world.queryObstaclesRadiusInto(
            { x: 5, y: 5 },
            2,
            [],
            {
                domainId:
                    "cellar-a",
            },
        ).map(obstacle =>
            obstacle.id),
        ["barrel-a"],
    );

    assert.deepEqual(
        world.queryObstaclesRadiusInto(
            { x: 5, y: 5 },
            2,
            [],
            {
                domainId:
                    "cellar-b",
            },
        ),
        [],
    );

    assert.deepEqual(
        world.queryObstaclesRadiusInto(
            { x: 5, y: 5 },
            2,
        ),
        [],
    );

    assert.equal(
        world.getDiagnostics()
            .occupiedObstacleDomainCount,
        1,
    );

    assert.equal(
        world.removeObstacle(
            "barrel-a",
        ),
        true,
    );

    assert.equal(
        world.getDiagnostics()
            .occupiedObstacleDomainCount,
        0,
    );

    world.assertInternalConsistency();
});

test("obstacle domains survive v1 snapshot round-trip", () => {
    const world = new World();
    const navigation =
        new Navigation();

    world.addDomain({
        id: "cellar",
    });

    world.addObstacle(
        {
            id: "barrel",
            type: "aabb",
            minX: 1,
            minY: 2,
            maxX: 3,
            maxY: 4,
        },
        {
            domainId:
                "cellar",
        },
    );

    const snapshot =
        serializeWorldCore(
            world,
            navigation,
        );

    assert.equal(
        snapshot.version,
        1,
    );
    assert.equal(
        snapshot.world
            .obstacles[0]
            .domainId,
        "cellar",
    );

    const restored =
        deserializeWorldCore(
            snapshot,
        ).world;

    assert.equal(
        restored.getObstacleDomain(
            "barrel",
        ),
        "cellar",
    );
    assert.equal(
        restored.queryObstaclesRadiusInto(
            { x: 2, y: 3 },
            2,
            [],
            {
                domainId: "cellar",
            },
        )[0].id,
        "barrel",
    );

    restored.assertInternalConsistency();
});


test("shared navigation registry and active journeys round-trip without topology duplication", async () => {
    const {
        startJourney,
        stepSimulation,
    } = await import(
        "../src/index.js"
    );

    const world =
        new World();
    const registry =
        new NavigationRegistry();
    const shared =
        new Navigation();

    shared.addNode({
        id: "entry",
        x: 0,
        y: 0,
    });
    shared.addNode({
        id: "room",
        x: 10,
        y: 0,
    });
    shared.addRoad({
        id: "hall",
        from: "entry",
        to: "room",
    });

    registry.registerTopology(
        "house-layout",
        shared,
    );

    for (
        const domainId of
        ["house-a", "house-b"]
    ) {
        world.addDomain({
            id: domainId,
        });
        registry.bindDomain(
            domainId,
            "house-layout",
        );
    }

    world.addEntity({
        id: "hans",
        domainId: "house-a",
        position: {
            x: 0,
            y: 0,
        },
        mobility: {
            speed: 1,
        },
    });
    world.addEntity({
        id: "anna",
        domainId: "house-b",
        position: {
            x: 0,
            y: 0,
        },
        mobility: {
            speed: 1,
        },
    });

    startJourney(
        world,
        registry,
        "hans",
        "room",
    );
    startJourney(
        world,
        registry,
        "anna",
        "room",
    );

    stepSimulation(
        world,
        registry,
        2,
    );

    const snapshot =
        serializeWorldCore(
            world,
            registry,
        );

    assert.equal(
        snapshot.version,
        1,
    );
    assert.equal(
        snapshot.navigation.type,
        "registry",
    );
    assert.equal(
        snapshot.navigation
            .topologies.length,
        1,
    );
    assert.equal(
        snapshot.navigation
            .domainBindings.length,
        2,
    );
    assert.equal(
        snapshot.routes.length,
        1,
    );
    assert.equal(
        snapshot.routes[0]
            .topologyId,
        "house-layout",
    );

    assert.equal(
        validateWorldCoreSnapshot(
            snapshot,
        ),
        true,
    );

    const restored =
        deserializeWorldCore(
            snapshot,
        );

    assert.ok(
        restored.navigation instanceof
            NavigationRegistry,
    );
    assert.equal(
        restored.navigation
            .topologies.size,
        1,
    );
    assert.equal(
        restored.navigation
            .navigationForDomain(
                "house-a",
            ),
        restored.navigation
            .navigationForDomain(
                "house-b",
            ),
    );

    stepSimulation(
        restored.world,
        restored.navigation,
        20,
    );

    assert.equal(
        restored.world
            .getEntity("hans")
            .journey,
        null,
    );
    assert.equal(
        restored.world
            .getEntity("anna")
            .journey,
        null,
    );

    restored.world
        .assertInternalConsistency();
    restored.navigation
        .assertInternalConsistency();
});


test("entity can walk across outdoor interior and cellar domains through explicit transfers", async () => {
    const {
        startJourney,
        stepSimulation,
    } = await import(
        "../src/index.js"
    );

    const world =
        new World({
            captureEvents: true,
        });
    const registry =
        new NavigationRegistry();

    world.addDomain({
        id: "tavern-ground",
    });
    world.addDomain({
        id: "tavern-cellar",
    });

    const outside =
        new Navigation();
    outside.addNode({
        id: "street",
        x: 0,
        y: 0,
    });
    outside.addNode({
        id: "tavern-door",
        x: 5,
        y: 0,
    });
    outside.addRoad({
        id: "street-to-door",
        from: "street",
        to: "tavern-door",
    });

    const ground =
        new Navigation();
    ground.addNode({
        id: "inside-door",
        x: 1,
        y: 4,
    });
    ground.addNode({
        id: "cellar-stairs",
        x: 8,
        y: 4,
    });
    ground.addRoad({
        id: "taproom-crossing",
        from: "inside-door",
        to: "cellar-stairs",
    });

    const cellar =
        new Navigation();
    cellar.addNode({
        id: "stairs-bottom",
        x: 2,
        y: 2,
    });
    cellar.addNode({
        id: "brew-area",
        x: 7,
        y: 6,
    });
    cellar.addRoad({
        id: "cellar-passage",
        from: "stairs-bottom",
        to: "brew-area",
    });

    registry.registerTopology(
        "outdoors",
        outside,
    );
    registry.setDefaultTopology(
        "outdoors",
    );
    registry.registerTopology(
        "tavern-ground-layout",
        ground,
    );
    registry.registerTopology(
        "tavern-cellar-layout",
        cellar,
    );
    registry.bindDomain(
        "tavern-ground",
        "tavern-ground-layout",
    );
    registry.bindDomain(
        "tavern-cellar",
        "tavern-cellar-layout",
    );

    world.addEntity({
        id: "hans",
        position: {
            x: 0,
            y: 0,
        },
        mobility: {
            speed: 2,
        },
    });

    assert.equal(
        startJourney(
            world,
            registry,
            "hans",
            "tavern-door",
        ),
        true,
    );

    stepSimulation(
        world,
        registry,
        3,
    );

    assert.equal(
        world.getEntity(
            "hans",
        ).journey,
        null,
    );
    assert.deepEqual(
        world.getEntity(
            "hans",
        ).position,
        {
            x: 5,
            y: 0,
        },
    );

    world.transferEntity(
        "hans",
        {
            domainId:
                "tavern-ground",
            position: {
                x: 1,
                y: 4,
            },
        },
    );

    assert.equal(
        startJourney(
            world,
            registry,
            "hans",
            "cellar-stairs",
        ),
        true,
    );

    stepSimulation(
        world,
        registry,
        4,
    );

    assert.equal(
        world.getEntity(
            "hans",
        ).journey,
        null,
    );

    world.transferEntity(
        "hans",
        {
            domainId:
                "tavern-cellar",
            position: {
                x: 2,
                y: 2,
            },
        },
    );

    assert.equal(
        startJourney(
            world,
            registry,
            "hans",
            "brew-area",
        ),
        true,
    );

    stepSimulation(
        world,
        registry,
        4,
    );

    const hans =
        world.getEntity("hans");

    assert.equal(
        hans.domainId,
        "tavern-cellar",
    );
    assert.equal(
        hans.journey,
        null,
    );
    assert.deepEqual(
        hans.position,
        {
            x: 7,
            y: 6,
        },
    );

    assert.deepEqual(
        world.peekEvents()
            .filter(event =>
                event.type ===
                "entityDomainTransferred")
            .map(event =>
                event.toDomainId),
        [
            "tavern-ground",
            "tavern-cellar",
        ],
    );

    world.assertInternalConsistency();
    registry.assertInternalConsistency();
});


test("unbound domains do not silently inherit the first registered topology", () => {
    const registry =
        new NavigationRegistry();
    const navigation =
        new Navigation();

    registry.registerTopology(
        "some-layout",
        navigation,
    );

    assert.equal(
        registry.navigationForDomain(
            "unbound-domain",
        ),
        null,
    );
    assert.equal(
        registry.defaultTopologyId,
        null,
    );
});


test("failed domain transfer leaves entity and spatial state unchanged", async () => {
    const {
        startJourney,
    } = await import(
        "../src/index.js"
    );

    const world =
        new World({
            captureEvents: true,
            eventQueueLimit: 2,
            eventOverflowPolicy:
                "throw",
        });
    const navigation =
        new Navigation();

    world.addDomain({
        id: "inside",
    });

    navigation.addNode({
        id: "a",
        x: 0,
        y: 0,
    });
    navigation.addNode({
        id: "b",
        x: 10,
        y: 0,
    });
    navigation.addRoad({
        id: "road",
        from: "a",
        to: "b",
    });

    world.addEntity({
        id: "hans",
        position: {
            x: 0,
            y: 0,
        },
        mobility: {
            speed: 1,
        },
    });

    assert.equal(
        startJourney(
            world,
            navigation,
            "hans",
            "b",
        ),
        true,
    );

    assert.equal(
        world.peekEvents().length,
        2,
    );

    const before =
        structuredClone(
            world.getEntity(
                "hans",
            ),
        );

    assert.throws(
        () =>
            world.transferEntity(
                "hans",
                {
                    domainId:
                        "inside",
                    position: {
                        x: 3,
                        y: 4,
                    },
                },
            ),
        /Event queue limit exceeded/,
    );

    const after =
        world.getEntity("hans");

    assert.equal(
        after.domainId,
        before.domainId,
    );
    assert.deepEqual(
        after.position,
        before.position,
    );
    assert.deepEqual(
        after.journey,
        before.journey,
    );

    assert.equal(
        world.queryRadius(
            { x: 0, y: 0 },
            1,
        )[0].id,
        "hans",
    );
    assert.deepEqual(
        world.queryRadius(
            { x: 3, y: 4 },
            1,
            {
                domainId:
                    "inside",
            },
        ),
        [],
    );

    world.assertInternalConsistency();
});


test("large bodies in one domain do not inflate spatial broadphase in another", () => {
    const world =
        new World({
            spatialCellSize: 10,
        });

    world.addDomain({
        id: "outside",
    });
    world.addDomain({
        id: "tiny-room",
    });

    world.addEntity({
        id: "giant",
        domainId: "outside",
        position: {
            x: 0,
            y: 0,
        },
        body: {
            radius: 1000,
        },
    });
    world.addEntity({
        id: "person",
        domainId: "tiny-room",
        position: {
            x: 5,
            y: 5,
        },
        body: {
            radius: 0.35,
        },
    });

    assert.equal(
        world.maxEntityRadius,
        1000,
    );
    assert.equal(
        world.getDomain(
            "outside",
        ).maxEntityRadius,
        1000,
    );
    assert.equal(
        world.getDomain(
            "tiny-room",
        ).maxEntityRadius,
        0.35,
    );

    const originalQuery =
        world.spatial
            .queryRadiusInto
            .bind(world.spatial);
    let queriedRadius = null;

    world.spatial.queryRadiusInto =
        (
            result,
            domainHandle,
            position,
            radius,
        ) => {
            queriedRadius = radius;

            return originalQuery(
                result,
                domainHandle,
                position,
                radius,
            );
        };

    assert.equal(
        world.queryRadius(
            { x: 5, y: 5 },
            2,
            {
                domainId:
                    "tiny-room",
            },
        )[0].id,
        "person",
    );

    assert.equal(
        queriedRadius,
        2.35,
    );

    world.removeEntity(
        "giant",
    );

    assert.equal(
        world.getDomain(
            "outside",
        ).maxEntityRadius,
        0,
    );

    world.assertInternalConsistency();
});

function buildSharedHouseTopology() {
    const navigation =
        new Navigation();

    navigation.addNode({
        id: "entrance",
        x: 0,
        y: 0,
    });
    navigation.addNode({
        id: "hall",
        x: 10,
        y: 0,
    });
    navigation.addNode({
        id: "side",
        x: 10,
        y: 10,
    });
    navigation.addNode({
        id: "bedroom",
        x: 20,
        y: 0,
    });

    navigation.addRoad({
        id: "entrance-hall",
        from: "entrance",
        to: "hall",
    });
    navigation.addRoad({
        id: "hall-bedroom",
        from: "hall",
        to: "bedroom",
    });
    navigation.addRoad({
        id: "entrance-side",
        from: "entrance",
        to: "side",
    });
    navigation.addRoad({
        id: "side-bedroom",
        from: "side",
        to: "bedroom",
    });

    return navigation;
}

test("one domain can block a shared-topology road without cloning or mutating the topology", () => {
    const world = new World();
    world.addDomain({
        id: "house-17",
    });
    world.addDomain({
        id: "house-18",
    });

    const topology =
        buildSharedHouseTopology();
    const registry =
        new NavigationRegistry();

    registry.registerTopology(
        "small-house",
        topology,
    );
    registry.bindDomain(
        "house-17",
        "small-house",
    );
    registry.bindDomain(
        "house-18",
        "small-house",
    );

    registry.setDomainRoadEffect(
        "house-17",
        "locked-door",
        "entrance-hall",
        {
            blocked: true,
        },
    );

    world.addEntity({
        id: "hans",
        domainId: "house-17",
        position: {
            x: 0,
            y: 0,
        },
        mobility: {
            speed: 1,
        },
    });
    world.addEntity({
        id: "anna",
        domainId: "house-18",
        position: {
            x: 0,
            y: 0,
        },
        mobility: {
            speed: 1,
        },
    });

    assert.equal(
        startJourney(
            world,
            registry,
            "hans",
            "bedroom",
        ),
        true,
    );
    assert.equal(
        startJourney(
            world,
            registry,
            "anna",
            "bedroom",
        ),
        true,
    );

    assert.deepEqual(
        world.getEntity("hans")
            .journey.route.legs
            .map(leg => leg.roadId),
        [
            "entrance-side",
            "side-bedroom",
        ],
    );
    assert.deepEqual(
        world.getEntity("anna")
            .journey.route.legs
            .map(leg => leg.roadId),
        [
            "entrance-hall",
            "hall-bedroom",
        ],
    );

    assert.equal(
        registry.topologies.size,
        1,
    );
    assert.equal(
        registry.domainInstances.size,
        1,
    );
    assert.equal(
        topology.roads
            .get("entrance-hall")
            .enabled,
        true,
    );
    assert.equal(
        topology.roadEffects
            .has("entrance-hall"),
        false,
    );

    registry.assertInternalConsistency();
});

test("domain navigation override changes invalidate and reroute active journeys", () => {
    const world = new World();
    world.addDomain({
        id: "house",
    });

    const topology =
        buildSharedHouseTopology();
    const registry =
        new NavigationRegistry();

    registry.registerTopology(
        "house-layout",
        topology,
    );
    registry.bindDomain(
        "house",
        "house-layout",
    );

    world.addEntity({
        id: "hans",
        domainId: "house",
        position: {
            x: 0,
            y: 0,
        },
        mobility: {
            speed: 1,
        },
    });

    assert.equal(
        startJourney(
            world,
            registry,
            "hans",
            "bedroom",
        ),
        true,
    );

    assert.equal(
        world.getEntity("hans")
            .journey.route.legs[0]
            .roadId,
        "entrance-hall",
    );

    registry.setDomainRoadEffect(
        "house",
        "door-closed",
        "entrance-hall",
        {
            blocked: true,
        },
    );

    stepSimulation(
        world,
        registry,
        1,
    );

    assert.equal(
        world.getEntity("hans")
            .journey.route.legs[0]
            .roadId,
        "entrance-side",
    );

    registry.removeDomainRoadEffect(
        "house",
        "door-closed",
        "entrance-hall",
    );

    assert.equal(
        registry.domainInstances
            .has("house"),
        false,
    );
    assert.strictEqual(
        registry.navigationForDomain(
            "house",
        ),
        topology,
    );
});

test("sparse domain navigation overrides survive v1 snapshot round-trips", () => {
    const world = new World();
    world.addDomain({
        id: "house",
    });

    const topology =
        buildSharedHouseTopology();
    const registry =
        new NavigationRegistry();

    registry.registerTopology(
        "house-layout",
        topology,
    );
    registry.bindDomain(
        "house",
        "house-layout",
    );
    registry.setDomainRoadEffect(
        "house",
        "locked",
        "entrance-hall",
        {
            blocked: true,
            costMultiplier: 3,
        },
    );

    world.addEntity({
        id: "hans",
        domainId: "house",
        position: {
            x: 0,
            y: 0,
        },
        mobility: {
            speed: 1,
        },
    });

    assert.equal(
        startJourney(
            world,
            registry,
            "hans",
            "bedroom",
        ),
        true,
    );

    const snapshot =
        serializeWorldCore(
            world,
            registry,
        );

    assert.equal(
        snapshot.version,
        1,
    );
    assert.deepEqual(
        snapshot.navigation
            .domainRoadEffects,
        [
            {
                domainId: "house",
                roadId:
                    "entrance-hall",
                effectId: "locked",
                blocked: true,
                costMultiplier: 3,
            },
        ],
    );
    assert.equal(
        validateWorldCoreSnapshot(
            snapshot,
        ),
        true,
    );

    const restored =
        deserializeWorldCore(
            structuredClone(
                snapshot,
            ),
        );

    const restoredNavigation =
        restored.navigation
            .navigationForDomain(
                "house",
            );

    assert.equal(
        restored.navigation
            .domainInstances.size,
        1,
    );
    assert.equal(
        restoredNavigation
            .canTraverseRoad(
                "entrance-hall",
                {
                    speed: 1,
                },
            ),
        false,
    );
    assert.equal(
        restored.world
            .getEntity("hans")
            .journey.route.legs[0]
            .roadId,
        "entrance-side",
    );

    restored.navigation
        .assertInternalConsistency();
    restored.world
        .assertInternalConsistency();
});

test("navigation instances stay sparse across many shared-topology domain bindings", () => {
    const topology =
        new Navigation();

    topology.addNode({
        id: "a",
        x: 0,
        y: 0,
    });
    topology.addNode({
        id: "b",
        x: 10,
        y: 0,
    });
    topology.addRoad({
        id: "hall",
        from: "a",
        to: "b",
    });

    const registry =
        new NavigationRegistry();
    registry.registerTopology(
        "layout",
        topology,
    );

    const domainCount = 10_000;
    const overriddenCount = 10;

    for (
        let index = 0;
        index < domainCount;
        index++
    ) {
        registry.bindDomain(
            `house-${index}`,
            "layout",
        );
    }

    assert.equal(
        registry.domainInstances.size,
        0,
    );

    for (
        let index = 0;
        index < overriddenCount;
        index++
    ) {
        registry.setDomainRoadEffect(
            `house-${index}`,
            "closed",
            "hall",
            {
                blocked: true,
            },
        );
    }

    const diagnostics =
        registry
            .assertInternalConsistency();

    assert.equal(
        diagnostics.boundDomainCount,
        domainCount,
    );
    assert.equal(
        diagnostics.topologyCount,
        1,
    );
    assert.equal(
        diagnostics.overriddenDomainCount,
        overriddenCount,
    );
    assert.equal(
        diagnostics.overrideRoadCount,
        overriddenCount,
    );
    assert.equal(
        diagnostics.overrideEffectCount,
        overriddenCount,
    );

    for (
        let index = 0;
        index < overriddenCount;
        index++
    ) {
        registry.removeDomainRoadEffect(
            `house-${index}`,
            "closed",
            "hall",
        );
    }

    assert.equal(
        registry.domainInstances.size,
        0,
    );

    assert.equal(
        registry.setDomainRoadEffect(
            "house-9999",
            "neutral",
            "hall",
            {
                blocked: false,
                costMultiplier: 1,
            },
        ),
        null,
    );
    assert.equal(
        registry.domainInstances.size,
        0,
    );
});

test("snapshot validation rejects domain road overrides against the wrong topology", () => {
    const world = new World();
    world.addDomain({
        id: "house",
    });

    const topology =
        buildSharedHouseTopology();
    const registry =
        new NavigationRegistry();

    registry.registerTopology(
        "layout",
        topology,
    );
    registry.bindDomain(
        "house",
        "layout",
    );
    registry.setDomainRoadEffect(
        "house",
        "closed",
        "entrance-hall",
        {
            blocked: true,
        },
    );

    const snapshot =
        serializeWorldCore(
            world,
            registry,
        );

    snapshot.navigation
        .domainRoadEffects[0]
        .roadId =
        "missing-road";

    assert.throws(
        () =>
            validateWorldCoreSnapshot(
                snapshot,
            ),
        /missing road in bound navigation topology/,
    );
});
