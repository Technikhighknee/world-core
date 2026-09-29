import assert from "node:assert/strict";
import test from "node:test";

import {
    DEFAULT_WORLD_DOMAIN_ID,
    Navigation,
    World,
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
