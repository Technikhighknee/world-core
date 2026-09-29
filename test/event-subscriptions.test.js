import test from "node:test";
import assert from "node:assert/strict";

import { World } from "../src/index.js";

test("live event subscribers receive events without enabling capture queue", () => {
  const world = new World({ captureEvents: false });
  const seen = [];

  const unsubscribe = world.subscribeEvents((event) => {
    seen.push(event);
  });

  assert.equal(world.getDiagnostics().eventListenerCount, 1);
  assert.equal(world.emitEvent("custom", { value: 42 }), null);

  assert.deepEqual(seen, [{
    time: 0,
    type: "custom",
    value: 42
  }]);
  assert.deepEqual(world.peekEvents(), []);

  assert.equal(unsubscribe(), true);
  assert.equal(unsubscribe(), false);
  assert.equal(world.getDiagnostics().eventListenerCount, 0);

  world.emitEvent("ignored");
  assert.equal(seen.length, 1);
});

test("live subscribers are independent from queue drop policies", () => {
  const world = new World({
    captureEvents: true,
    eventQueueLimit: 1,
    eventOverflowPolicy: "drop-newest"
  });
  const seen = [];
  world.subscribeEvents((event) => seen.push(event.type));

  world.emitEvent("one");
  world.emitEvent("two");

  assert.deepEqual(seen, ["one", "two"]);
  assert.deepEqual(world.peekEvents().map((event) => event.type), ["one"]);
  assert.equal(world.getEventQueueStats().dropped, 1);
});

test("throw overflow fails before dispatching an event that cannot be queued", () => {
  const world = new World({
    captureEvents: true,
    eventQueueLimit: 1,
    eventOverflowPolicy: "throw"
  });
  const seen = [];
  world.subscribeEvents((event) => seen.push(event.type));

  world.emitEvent("one");
  assert.throws(
    () => world.emitEvent("two"),
    /Event queue limit exceeded/
  );

  assert.deepEqual(seen, ["one"]);
});

test("subscription dispatch uses a stable listener snapshot", () => {
  const world = new World();
  const seen = [];

  let unsubscribeA;
  unsubscribeA = world.subscribeEvents(() => {
    seen.push("a");
    unsubscribeA();
  });
  world.subscribeEvents(() => {
    seen.push("b");
  });

  world.emitEvent("first");
  world.emitEvent("second");

  assert.deepEqual(seen, ["a", "b", "b"]);
  assert.equal(world.getDiagnostics().eventListenerCount, 1);
});

test("subscribeEvents rejects non-functions", () => {
  const world = new World();
  assert.throws(() => world.subscribeEvents(null), /listener/);
});
