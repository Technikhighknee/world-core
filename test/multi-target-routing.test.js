import test from "node:test";
import assert from "node:assert/strict";

import {
  Navigation,
  NavigationRegistry
} from "../src/index.js";

const mobility = {
  speed: 1,
  surfaceMultipliers: {},
  requiredRoadWidth: 0,
  requiredRoadTags: [],
  blockedRoadTags: []
};

function buildNavigation() {
  const navigation = new Navigation();
  navigation.addNode({ id: "start", x: 0, y: 0 });
  navigation.addNode({ id: "junction", x: 10, y: 0 });
  navigation.addNode({ id: "near", x: 20, y: 0 });
  navigation.addNode({ id: "far", x: 40, y: 0 });
  navigation.addRoad({
    id: "start-junction",
    from: "start",
    to: "junction",
    width: 4
  });
  navigation.addRoad({
    id: "junction-near",
    from: "junction",
    to: "near",
    width: 4
  });
  navigation.addRoad({
    id: "junction-far",
    from: "junction",
    to: "far",
    width: 4
  });
  return navigation;
}

test("findRouteToAny chooses the cheapest reachable destination in one search", () => {
  const navigation = buildNavigation();

  const route = navigation.findRouteToAny(
    "start",
    ["far", "near"],
    mobility
  );

  assert.ok(route);
  assert.equal(route.destinationNodeId, "near");
  assert.equal(route.estimatedSeconds, 20);
  assert.deepEqual(
    route.legs.map((leg) => leg.roadId),
    ["start-junction", "junction-near"]
  );
});

test("findRouteFromPositionToAny handles road starts without N single-target searches", () => {
  const navigation = buildNavigation();

  const planned = navigation.findRouteFromPositionToAny(
    { x: 5, y: 0 },
    ["far", "near"],
    mobility
  );

  assert.ok(planned);
  assert.equal(planned.route.destinationNodeId, "near");
  assert.equal(planned.estimatedSeconds, 15);
  assert.equal(planned.prefixLeg.roadId, "start-junction");
});

test("multi-target routing respects domain-local road overlays", () => {
  const topology = buildNavigation();
  const registry = new NavigationRegistry();
  registry.registerTopology("shared", topology);
  registry.bindDomain("house-domain", "shared");
  registry.setDomainRoadEffect(
    "house-domain",
    "locked-near",
    "junction-near",
    { blocked: true }
  );

  const instance = registry.navigationForDomain("house-domain");
  const route = instance.findRouteToAny(
    "start",
    ["near", "far"],
    mobility
  );

  assert.ok(route);
  assert.equal(route.destinationNodeId, "far");
  assert.equal(route.estimatedSeconds, 40);
});

test("multi-target routing is deterministic on equal-cost destinations", () => {
  const navigation = new Navigation();
  navigation.addNode({ id: "start", x: 0, y: 0 });
  navigation.addNode({ id: "a", x: 10, y: 0 });
  navigation.addNode({ id: "b", x: -10, y: 0 });
  navigation.addRoad({ id: "to-a", from: "start", to: "a", width: 4 });
  navigation.addRoad({ id: "to-b", from: "start", to: "b", width: 4 });

  const route = navigation.findRouteToAny(
    "start",
    ["b", "a"],
    mobility
  );

  assert.ok(route);
  assert.equal(route.destinationNodeId, "a");
});
