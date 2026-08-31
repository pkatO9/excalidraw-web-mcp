import { layoutGraph } from "../ai-agent/layout";

import type { LayoutEdge, LayoutNode, LayoutResult } from "../ai-agent/layout";

/**
 * The point of the layout engine is a property the incremental tools cannot
 * hold: no arrow crosses a box it does not connect. These tests assert that
 * geometrically, on the real graph that exposed the problem.
 */

const box = (key: string, width = 180, height = 80): LayoutNode => ({
  key,
  width,
  height,
});

type Rect = { x: number; y: number; width: number; height: number };

const rectFor = (
  key: string,
  nodes: LayoutNode[],
  placed: Map<string, { x: number; y: number }>,
): Rect => {
  const node = nodes.find((candidate) => candidate.key === key)!;
  const at = placed.get(key)!;
  return { x: at.x, y: at.y, width: node.width, height: node.height };
};

const centreOf = (rect: Rect) => ({
  x: rect.x + rect.width / 2,
  y: rect.y + rect.height / 2,
});

/**
 * Where bind_arrow actually anchors — mirrors `edgeAnchor` in toolLayer.ts:
 * the dominant axis between the two centres picks bottom/top or right/left.
 * Testing centre-to-centre would overstate crossings, because a real arrow
 * leaves the box edge and never travels through its own layer band.
 */
const anchorOn = (
  from: Rect,
  to: Rect | { x: number; y: number },
  axis: "vertical" | "horizontal" = "vertical",
) => {
  const a = centreOf(from);
  const b = "width" in to ? centreOf(to) : to;
  const dx = b.x - a.x;
  const dy = b.y - a.y;

  // create_diagram pins the axis to match the layout direction, so a TB
  // diagram always leaves the bottom and enters the top.
  if (axis === "vertical") {
    return dy >= 0
      ? { x: a.x, y: from.y + from.height }
      : { x: a.x, y: from.y };
  }
  return dx >= 0 ? { x: from.x + from.width, y: a.y } : { x: from.x, y: a.y };
};

/** Does segment a-b pass through rect? Slab method, shrunk to ignore touching. */
const segmentHitsRect = (
  a: { x: number; y: number },
  b: { x: number; y: number },
  rect: Rect,
) => {
  const pad = 4; // ignore grazing the very edge
  const minX = rect.x + pad;
  const maxX = rect.x + rect.width - pad;
  const minY = rect.y + pad;
  const maxY = rect.y + rect.height - pad;
  if (minX >= maxX || minY >= maxY) {
    return false;
  }

  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;

  const clip = (p: number, q: number) => {
    if (p === 0) {
      return q >= 0;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) {
        return false;
      }
      if (r > t0) {
        t0 = r;
      }
    } else {
      if (r < t0) {
        return false;
      }
      if (r < t1) {
        t1 = r;
      }
    }
    return true;
  };

  return (
    clip(-dx, a.x - minX) &&
    clip(dx, maxX - a.x) &&
    clip(-dy, a.y - minY) &&
    clip(dy, maxY - a.y)
  );
};

const arrowsThroughBoxes = (
  nodes: LayoutNode[],
  edges: LayoutEdge[],
  result: LayoutResult,
  axis: "vertical" | "horizontal" = "vertical",
) => {
  const placed = result.placements;
  const offences: string[] = [];

  edges.forEach((edge, index) => {
    const fromRect = rectFor(edge.from, nodes, placed);
    const toRect = rectFor(edge.to, nodes, placed);
    const waypoints = result.routes[index] ?? [];

    // The drawn arrow is a polyline: box edge, each reserved corridor, box edge.
    const path = [
      anchorOn(fromRect, waypoints[0] ?? toRect, axis),
      ...waypoints,
      anchorOn(toRect, waypoints[waypoints.length - 1] ?? fromRect, axis),
    ];

    for (const node of nodes) {
      if (node.key === edge.from || node.key === edge.to) {
        continue;
      }
      const rect = rectFor(node.key, nodes, placed);
      for (let i = 0; i + 1 < path.length; i++) {
        if (segmentHitsRect(path[i], path[i + 1], rect)) {
          offences.push(`${edge.from}->${edge.to} cuts through ${node.key}`);
          break;
        }
      }
    }
  });

  return offences;
};

const overlappingBoxes = (
  nodes: LayoutNode[],
  placed: Map<string, { x: number; y: number }>,
) => {
  const offences: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = rectFor(nodes[i].key, nodes, placed);
      const b = rectFor(nodes[j].key, nodes, placed);
      if (
        a.x < b.x + b.width &&
        b.x < a.x + a.width &&
        a.y < b.y + b.height &&
        b.y < a.y + a.height
      ) {
        offences.push(`${nodes[i].key} overlaps ${nodes[j].key}`);
      }
    }
  }
  return offences;
};

describe("layoutGraph", () => {
  it("lays out the ride-hailing graph with no arrow cutting through a box", () => {
    // This is the diagram from the report: incremental placement produced
    // arrows slicing diagonally across Auth Service and Notification Service.
    const nodes = [
      box("rider"),
      box("gateway"),
      box("dispatch"),
      box("driver"),
      box("matching"),
      box("auth"),
      box("trip"),
      box("payment"),
      box("notification"),
      box("datastore"),
    ];
    const edges: LayoutEdge[] = [
      { from: "rider", to: "gateway" },
      { from: "gateway", to: "dispatch" },
      { from: "gateway", to: "auth" },
      { from: "dispatch", to: "driver" },
      { from: "dispatch", to: "matching" },
      { from: "dispatch", to: "trip" },
      { from: "dispatch", to: "notification" },
      { from: "matching", to: "datastore" },
      { from: "trip", to: "datastore" },
      { from: "payment", to: "datastore" },
      { from: "notification", to: "datastore" },
      { from: "auth", to: "datastore" },
      { from: "trip", to: "payment" },
    ];

    const result = layoutGraph(nodes, edges);

    expect(result.placements.size).toBe(nodes.length);
    expect(overlappingBoxes(nodes, result.placements)).toEqual([]);
    expect(arrowsThroughBoxes(nodes, edges, result)).toEqual([]);
  });

  it("handles the denser graph the model actually produced", () => {
    // Captured from a live run: 10 nodes, 17 edges. Denser than the reported
    // case, and the shape real requests tend to have.
    const keys = [
      "rider_app",
      "api_gateway",
      "auth_service",
      "dispatch_service",
      "matching_service",
      "trip_pricing_service",
      "payment_service",
      "notification_service",
      "driver_app",
      "shared_data_store",
    ];
    const nodes = keys.map((key) => box(key));
    const edges: LayoutEdge[] = [
      { from: "rider_app", to: "api_gateway" },
      { from: "api_gateway", to: "auth_service" },
      { from: "api_gateway", to: "dispatch_service" },
      { from: "dispatch_service", to: "matching_service" },
      { from: "dispatch_service", to: "trip_pricing_service" },
      { from: "dispatch_service", to: "notification_service" },
      { from: "matching_service", to: "driver_app" },
      { from: "trip_pricing_service", to: "payment_service" },
      { from: "payment_service", to: "shared_data_store" },
      { from: "matching_service", to: "shared_data_store" },
      { from: "trip_pricing_service", to: "shared_data_store" },
      { from: "auth_service", to: "shared_data_store" },
      { from: "notification_service", to: "shared_data_store" },
      { from: "dispatch_service", to: "shared_data_store" },
      { from: "notification_service", to: "driver_app" },
      { from: "notification_service", to: "rider_app" },
      { from: "driver_app", to: "api_gateway" },
    ];

    const result = layoutGraph(nodes, edges);
    expect(overlappingBoxes(nodes, result.placements)).toEqual([]);
    expect(arrowsThroughBoxes(nodes, edges, result)).toEqual([]);
  });

  it("keeps a long edge clear of the layers it spans", () => {
    // The specific failure mode: an edge skipping layers is drawn straight, so
    // without a reserved corridor it slices through whatever sits between.
    const nodes = [box("a"), box("b"), box("c"), box("d")];
    const edges: LayoutEdge[] = [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "d" },
      { from: "a", to: "d" }, // spans three layers
    ];

    const result = layoutGraph(nodes, edges);
    expect(arrowsThroughBoxes(nodes, edges, result)).toEqual([]);
  });

  it("puts sources above their dependents and respects depth", () => {
    const nodes = [box("a"), box("b"), box("c")];
    const result = layoutGraph(nodes, [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ]);

    expect(result.placements.get("a")!.y).toBeLessThan(
      result.placements.get("b")!.y,
    );
    expect(result.placements.get("b")!.y).toBeLessThan(
      result.placements.get("c")!.y,
    );
  });

  it("lays out left-to-right when asked", () => {
    const nodes = [box("a"), box("b")];
    const result = layoutGraph(nodes, [{ from: "a", to: "b" }], {
      direction: "LR",
    });

    expect(result.placements.get("a")!.x).toBeLessThan(
      result.placements.get("b")!.x,
    );
    expect(result.placements.get("a")!.y).toBe(result.placements.get("b")!.y);
  });

  it("terminates on a cycle instead of hanging", () => {
    const nodes = [box("a"), box("b"), box("c")];
    const result = layoutGraph(nodes, [
      { from: "a", to: "b" },
      { from: "b", to: "c" },
      { from: "c", to: "a" }, // closes the loop
    ]);

    expect(result.placements.size).toBe(3);
    expect(overlappingBoxes(nodes, result.placements)).toEqual([]);
  });

  it("places disconnected nodes without stacking them", () => {
    const nodes = [box("a"), box("b"), box("lonely")];
    const result = layoutGraph(nodes, [{ from: "a", to: "b" }]);

    expect(result.placements.size).toBe(3);
    expect(overlappingBoxes(nodes, result.placements)).toEqual([]);
  });

  it("honours differing box sizes without overlapping", () => {
    const nodes = [
      box("wide", 420, 80),
      box("narrow", 120, 80),
      box("tall", 180, 200),
    ];
    const result = layoutGraph(nodes, [
      { from: "wide", to: "narrow" },
      { from: "wide", to: "tall" },
    ]);

    expect(overlappingBoxes(nodes, result.placements)).toEqual([]);
  });

  it("ignores edges naming an unknown node rather than throwing", () => {
    const nodes = [box("a"), box("b")];
    const result = layoutGraph(nodes, [
      { from: "a", to: "b" },
      { from: "a", to: "ghost" },
    ]);

    expect(result.placements.size).toBe(2);
  });

  it("returns nothing for an empty graph", () => {
    expect(layoutGraph([], []).placements.size).toBe(0);
  });
});
