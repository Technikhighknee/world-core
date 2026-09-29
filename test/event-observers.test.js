import test from "node:test";
import assert from "node:assert/strict";

import { World } from "../src/index.js";

test("event observers receive live events without enabling the capture queue", () => {
    const world = new World();
    const seen = [];

    const unsubscribe =
        world.subscribeEvents(
            event => seen.push(event),
        );

    const returned =
        world.emitEvent(
            "live-only",
            { value: 7 },
        );

    assert.equal(returned, null);
    assert.equal(world.peekEvents().length, 0);
    assert.deepEqual(
        seen.map(event => ({
            type: event.type,
            value: event.value,
            time: event.time,
        })),
        [{
            type: "live-only",
            value: 7,
            time: 0,
        }],
    );

    assert.equal(unsubscribe(), true);
    assert.equal(unsubscribe(), false);

    world.emitEvent("after-unsubscribe");
    assert.equal(seen.length, 1);
});

test("observer failures cannot alter event delivery or simulation state", () => {
    const world = new World();
    const seen = [];
    const errors = [];

    world.subscribeEvents(
        () => {
            throw new Error("observer exploded");
        },
        {
            onError(error, event) {
                errors.push({
                    message: error.message,
                    type: event.type,
                });
            },
        },
    );

    world.subscribeEvents(
        event => seen.push(event.type),
    );

    assert.doesNotThrow(() =>
        world.emitEvent("safe-live-event")
    );

    assert.deepEqual(seen, ["safe-live-event"]);
    assert.deepEqual(errors, [{
        message: "observer exploded",
        type: "safe-live-event",
    }]);
});

test("event observers see events dropped by the bounded capture queue", () => {
    const world = new World({
        captureEvents: true,
        eventQueueLimit: 1,
        eventOverflowPolicy: "drop-newest",
    });
    const seen = [];

    world.subscribeEvents(
        event => seen.push(event.type),
    );

    world.emitEvent("queued");
    world.emitEvent("live-but-dropped");

    assert.deepEqual(seen, [
        "queued",
        "live-but-dropped",
    ]);
    assert.deepEqual(
        world.peekEvents().map(event => event.type),
        ["queued"],
    );
    assert.equal(world.droppedEventCount, 1);
});

test("domain transfer observers work when event capture is disabled", () => {
    const world = new World();
    world.addDomain({ id: "inside" });
    world.addEntity({
        id: "hans",
        domainId: "default",
        position: { x: 1, y: 2 },
    });

    const seen = [];
    world.subscribeEvents(
        event => seen.push(event),
    );

    world.transferEntity(
        "hans",
        {
            domainId: "inside",
            position: { x: 3, y: 4 },
        },
    );

    assert.equal(
        world.getEntity("hans").domainId,
        "inside",
    );
    assert.deepEqual(
        world.getEntity("hans").position,
        { x: 3, y: 4 },
    );
    assert.ok(seen.some(event =>
        event.type === "entityDomainTransferred" &&
        event.entityId === "hans" &&
        event.fromDomainId === "default" &&
        event.toDomainId === "inside"
    ));
    assert.equal(world.peekEvents().length, 0);
});

test("subscriber removal during delivery prevents later invocation in the same emission", () => {
    const world = new World();
    const seen = [];

    let unsubscribeSecond;
    world.subscribeEvents(() => {
        seen.push("first");
        unsubscribeSecond();
    });
    unsubscribeSecond =
        world.subscribeEvents(() => {
            seen.push("second");
        });

    world.emitEvent("x");

    assert.deepEqual(seen, ["first"]);
});


test("live observers cannot mutate shared event envelopes", () => {
    const world = new World({
        captureEvents: true,
    });
    const seen = [];

    world.subscribeEvents(event => {
        assert.throws(
            () => {
                event.type = "corrupted";
            },
            TypeError,
        );
        seen.push(event.type);
    });

    world.subscribeEvents(event => {
        seen.push(event.type);
    });

    world.emitEvent("stable-event", {
        value: 17,
    });

    assert.deepEqual(seen, [
        "stable-event",
        "stable-event",
    ]);
    assert.deepEqual(
        world.peekEvents().map(event => ({
            type: event.type,
            value: event.value,
        })),
        [{
            type: "stable-event",
            value: 17,
        }],
    );
});
