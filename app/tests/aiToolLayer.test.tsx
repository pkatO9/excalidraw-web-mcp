import { resolvablePromise } from "@excalidraw/common";
import { Excalidraw } from "@excalidraw/excalidraw";
import { render } from "@excalidraw/excalidraw/tests/test-utils";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import {
  add_rectangle,
  add_text,
  bind_arrow,
  get_scene,
  remove_element,
  set_style,
} from "../ai-agent/toolLayer";

describe("AI agent tool layer", () => {
  let api: ExcalidrawImperativeAPI;

  beforeEach(async () => {
    const apiPromise = resolvablePromise<ExcalidrawImperativeAPI>();
    await render(
      <Excalidraw onExcalidrawAPI={(a) => apiPromise.resolve(a as any)} />,
    );
    api = await apiPromise;
  });

  it("get_scene returns an empty list for a fresh canvas", () => {
    expect(get_scene(api)).toEqual([]);
  });

  it("add_rectangle places a labelled box at the exact coordinates asked for", () => {
    const created = add_rectangle(api, {
      x: 120,
      y: 240,
      width: 180,
      height: 80,
      label: "Load Balancer",
    });

    expect(created).toMatchObject({
      type: "rectangle",
      x: 120,
      y: 240,
      width: 180,
      height: 80,
    });

    const scene = get_scene(api);
    expect(scene).toHaveLength(1);
    expect(scene[0]).toMatchObject({
      id: created.id,
      type: "rectangle",
      x: 120,
      y: 240,
      width: 180,
      height: 80,
      label: "Load Balancer",
    });
  });

  it("honours the requested position when it is free", () => {
    const box = add_rectangle(api, {
      x: 300,
      y: 200,
      width: 180,
      height: 80,
      label: "Free spot",
    });
    expect(box).toMatchObject({ x: 300, y: 200 });
    expect((box as any).moved_from).toBeUndefined();
  });

  it("nudges a colliding box to the nearest free spot instead of overlapping", () => {
    add_rectangle(api, {
      x: 300,
      y: 200,
      width: 180,
      height: 80,
      label: "First",
    });

    // exactly on top of the first box
    const second = add_rectangle(api, {
      x: 300,
      y: 200,
      width: 180,
      height: 80,
      label: "Second",
    });

    expect((second as any).moved_from).toEqual({ x: 300, y: 200 });
    expectNoOverlaps(get_scene(api));

    // and it stays near where it was asked for rather than flying off
    expect(Math.abs(second.x - 300)).toBeLessThan(400);
    expect(Math.abs(second.y - 200)).toBeLessThan(400);
  });

  it("keeps a whole batch of boxes disjoint even when all are placed at one point", () => {
    // Reproduces the real failure: the model emits a batch of add_rectangle
    // calls in a single turn, so it cannot see any of them before choosing
    // coordinates. The tool layer has to hold the invariant on its own.
    const labels = ["A", "B", "C", "D", "E", "F", "G", "H"];
    for (const label of labels) {
      add_rectangle(api, {
        x: 400,
        y: 300,
        width: 180,
        height: 80,
        label,
      });
    }

    const scene = get_scene(api);
    expect(scene).toHaveLength(labels.length);
    expectNoOverlaps(scene);
  });

  it("does not treat arrows as obstacles when placing", () => {
    const a = add_rectangle(api, {
      x: 0,
      y: 0,
      width: 180,
      height: 80,
      label: "A",
    });
    const b = add_rectangle(api, {
      x: 0,
      y: 400,
      width: 180,
      height: 80,
      label: "B",
    });
    bind_arrow(api, { source_id: a.id, target_id: b.id });

    // the gap between A and B is crossed by an arrow but is otherwise free
    const c = add_rectangle(api, {
      x: 400,
      y: 200,
      width: 180,
      height: 80,
      label: "C",
    });
    expect(c).toMatchObject({ x: 400, y: 200 });
  });

  it("add_text adds a standalone text element", () => {
    const created = add_text(api, {
      x: 40,
      y: 10,
      text: "3-Tier Architecture",
    });

    const scene = get_scene(api);
    expect(scene).toHaveLength(1);
    expect(scene[0]).toMatchObject({
      id: created.id,
      type: "text",
      x: 40,
      y: 10,
      label: "3-Tier Architecture",
    });
  });

  it("bind_arrow uses Excalidraw's native binding on both ends", () => {
    const a = add_rectangle(api, {
      x: 0,
      y: 0,
      width: 180,
      height: 80,
      label: "App Server",
    });
    const b = add_rectangle(api, {
      x: 400,
      y: 0,
      width: 180,
      height: 80,
      label: "Database",
    });

    const arrow = bind_arrow(api, { source_id: a.id, target_id: b.id });
    expect(arrow.bound).toBe(true);

    const elements = api.getSceneElements();
    const arrowEl: any = elements.find((el) => el.id === arrow.id);

    // The real binding system, not two guessed coordinates.
    expect(arrowEl.type).toBe("arrow");
    expect(arrowEl.startBinding?.elementId).toBe(a.id);
    expect(arrowEl.endBinding?.elementId).toBe(b.id);

    // Both shapes know about the arrow, which is what makes it follow them.
    const source: any = elements.find((el) => el.id === a.id);
    const target: any = elements.find((el) => el.id === b.id);
    expect(source.boundElements.map((x: any) => x.id)).toContain(arrow.id);
    expect(target.boundElements.map((x: any) => x.id)).toContain(arrow.id);

    // Labels survived the rebuild that binding performs.
    const scene = get_scene(api);
    expect(scene.find((el) => el.id === a.id)?.label).toBe("App Server");
    expect(scene.find((el) => el.id === b.id)?.label).toBe("Database");
    expect(scene.find((el) => el.id === arrow.id)).toMatchObject({
      startBinding: a.id,
      endBinding: b.id,
    });
  });

  it("bind_arrow anchors on the shape edges, not their centres", () => {
    // Regression test. Seeding the arrow centre-to-centre produced a
    // fixedPoint of [0.5, 0.5], i.e. an arrow starting inside the box and
    // skewering it. Endpoints must sit on the outline instead.
    const top = add_rectangle(api, {
      x: 200,
      y: 100,
      width: 180,
      height: 80,
      label: "Load Balancer",
    });
    const bottom = add_rectangle(api, {
      x: 200,
      y: 400,
      width: 180,
      height: 80,
      label: "Database",
    });

    const arrow = bind_arrow(api, { source_id: top.id, target_id: bottom.id });
    const el: any = api.getSceneElements().find((e) => e.id === arrow.id);

    // Anchors are on the boundary: [x fraction, y fraction] within the shape.
    expect(el.startBinding.fixedPoint[1]).toBeCloseTo(1, 2); // bottom edge
    expect(el.endBinding.fixedPoint[1]).toBeCloseTo(0, 2); // top edge
    expect(el.startBinding.fixedPoint[0]).toBeCloseTo(0.5, 1); // horizontally centred
    expect(el.endBinding.fixedPoint[0]).toBeCloseTo(0.5, 1);

    // And the drawn geometry agrees: neither endpoint is inside either box.
    const start = { x: el.x + el.points[0][0], y: el.y + el.points[0][1] };
    const last = el.points[el.points.length - 1];
    const end = { x: el.x + last[0], y: el.y + last[1] };

    for (const point of [start, end]) {
      for (const box of [top, bottom]) {
        const inside =
          point.x > box.x + 1 &&
          point.x < box.x + box.width - 1 &&
          point.y > box.y + 1 &&
          point.y < box.y + box.height - 1;
        expect(inside).toBe(false);
      }
    }

    // A vertical relationship draws a vertical arrow, not a diagonal one.
    expect(Math.abs(start.x - end.x)).toBeLessThan(2);
  });

  it("bind_arrow picks the left/right edges for a horizontal relationship", () => {
    const left = add_rectangle(api, {
      x: 0,
      y: 200,
      width: 180,
      height: 80,
      label: "App Server",
    });
    const right = add_rectangle(api, {
      x: 400,
      y: 200,
      width: 180,
      height: 80,
      label: "Cache",
    });

    const arrow = bind_arrow(api, { source_id: left.id, target_id: right.id });
    const el: any = api.getSceneElements().find((e) => e.id === arrow.id);

    expect(el.startBinding.fixedPoint[0]).toBeCloseTo(1, 2); // right edge of source
    expect(el.endBinding.fixedPoint[0]).toBeCloseTo(0, 2); // left edge of target
    expect(el.startBinding.fixedPoint[1]).toBeCloseTo(0.5, 1); // vertically centred
    expect(el.endBinding.fixedPoint[1]).toBeCloseTo(0.5, 1);
  });

  it("bind_arrow reports a usable error for an unknown id", () => {
    const a = add_rectangle(api, {
      x: 0,
      y: 0,
      width: 180,
      height: 80,
      label: "A",
    });
    expect(() =>
      bind_arrow(api, { source_id: a.id, target_id: "does-not-exist" }),
    ).toThrow(/does not exist/);
  });

  it("leaves a diagram uncoloured unless colours are asked for", () => {
    const box = add_rectangle(api, {
      x: 0,
      y: 0,
      width: 180,
      height: 80,
      label: "Plain",
    });
    const el: any = api.getSceneElements().find((e) => e.id === box.id);

    expect(el.backgroundColor).toBe("transparent");
    expect(el.strokeColor).toBe("#1e1e1e");

    // house style: rounded corners and a single-line hachure fill
    expect(el.roundness).toEqual({ type: 3 }); // ROUNDNESS.ADAPTIVE_RADIUS
    expect(el.fillStyle).toBe("hachure");

    // and an unstyled element reports no colour, keeping get_scene terse
    const summary = get_scene(api).find((e) => e.id === box.id)!;
    expect(summary.backgroundColor).toBeUndefined();
    expect(summary.strokeColor).toBeUndefined();
  });

  it("add_rectangle applies colours when they are supplied", () => {
    const box = add_rectangle(api, {
      x: 0,
      y: 0,
      width: 180,
      height: 80,
      label: "Database",
      backgroundColor: "#ffec99",
      strokeColor: "#f08c00",
    });
    const el: any = api.getSceneElements().find((e) => e.id === box.id);

    expect(el.backgroundColor).toBe("#ffec99");
    expect(el.strokeColor).toBe("#f08c00");
    // colouring a box does not lose the rounded/hachure house style
    expect(el.roundness).toEqual({ type: 3 });
    expect(el.fillStyle).toBe("hachure");

    const summary = get_scene(api).find((e) => e.id === box.id)!;
    expect(summary.backgroundColor).toBe("#ffec99");
    expect(summary.strokeColor).toBe("#f08c00");
  });

  it("an explicit fillStyle still overrides the hachure default", () => {
    const box = add_rectangle(api, {
      x: 0,
      y: 0,
      width: 180,
      height: 80,
      label: "Solid",
      backgroundColor: "#a5d8ff",
      fillStyle: "solid",
    });
    const el: any = api.getSceneElements().find((e) => e.id === box.id);
    expect(el.fillStyle).toBe("solid");
    expect(el.roundness).toEqual({ type: 3 });
  });

  it("set_style recolours an existing diagram without disturbing it", () => {
    const a = add_rectangle(api, {
      x: 0,
      y: 0,
      width: 180,
      height: 80,
      label: "App Server",
    });
    const b = add_rectangle(api, {
      x: 400,
      y: 0,
      width: 180,
      height: 80,
      label: "Database",
    });
    const arrow = bind_arrow(api, { source_id: a.id, target_id: b.id });

    const result = set_style(api, {
      ids: [a.id, b.id],
      backgroundColor: "#b2f2bb",
      strokeColor: "#2f9e44",
    });
    expect(result.styled_ids).toEqual([a.id, b.id]);

    const scene = get_scene(api);
    for (const id of [a.id, b.id]) {
      const el = scene.find((e) => e.id === id)!;
      expect(el.backgroundColor).toBe("#b2f2bb");
      expect(el.strokeColor).toBe("#2f9e44");
    }

    // the whole point of editing in place: geometry, labels and the binding survive
    const box = scene.find((e) => e.id === a.id)!;
    expect(box).toMatchObject({ x: 0, y: 0, width: 180, height: 80 });
    expect(box.label).toBe("App Server");
    expect(scene.find((e) => e.id === arrow.id)).toMatchObject({
      startBinding: a.id,
      endBinding: b.id,
    });
  });

  it("deleting an already-cascaded arrow is a no-op, not an error", () => {
    // Regression: deleting a multi-selection of shapes AND the arrows between
    // them used to fail on the arrows, because deleting a shape already takes
    // its bound arrows with it. The end state was right but it reported errors.
    const a = add_rectangle(api, {
      x: 0,
      y: 0,
      width: 180,
      height: 80,
      label: "Load Balancer",
    });
    const b = add_rectangle(api, {
      x: 400,
      y: 0,
      width: 180,
      height: 80,
      label: "App Server",
    });
    const arrow = bind_arrow(api, { source_id: a.id, target_id: b.id });

    // deleting the shape cascades to the arrow
    const first = remove_element(api, { id: a.id });
    expect(first.removed_ids).toContain(arrow.id);

    // and deleting that same arrow afterwards is a harmless no-op
    const second = remove_element(api, { id: arrow.id });
    expect(second.already_removed).toBe(true);
    expect(second.removed_ids).toEqual([]);

    // an id that never existed is still a real error
    expect(() => remove_element(api, { id: "never-existed" })).toThrow(
      /does not exist/,
    );

    // end state: only the untouched box survives
    const scene = get_scene(api);
    expect(scene.map((el) => el.id)).toEqual([b.id]);
  });

  it("set_style rejects unknown ids and empty patches", () => {
    const a = add_rectangle(api, {
      x: 0,
      y: 0,
      width: 180,
      height: 80,
      label: "A",
    });
    expect(() =>
      set_style(api, { ids: ["nope"], backgroundColor: "#a5d8ff" }),
    ).toThrow(/does not exist/);
    expect(() => set_style(api, { ids: [a.id] })).toThrow(/at least one of/);
  });

  it("remove_element deletes the shape, its label and any arrows bound to it", () => {
    const a = add_rectangle(api, {
      x: 0,
      y: 0,
      width: 180,
      height: 80,
      label: "Cache",
    });
    const b = add_rectangle(api, {
      x: 400,
      y: 0,
      width: 180,
      height: 80,
      label: "Database",
    });
    bind_arrow(api, { source_id: a.id, target_id: b.id });

    expect(get_scene(api)).toHaveLength(3); // two boxes + one arrow

    remove_element(api, { id: a.id });

    const scene = get_scene(api);
    expect(scene).toHaveLength(1);
    expect(scene[0].id).toBe(b.id);
    // no dangling arrow left behind
    expect(scene.some((el) => el.type === "arrow")).toBe(false);
    // and the deleted box's label text went with it
    expect(
      api
        .getSceneElements()
        .some((el) => el.type === "text" && el.text === "Cache"),
    ).toBe(false);
  });
});

function expectNoOverlaps(boxes: ReturnType<typeof get_scene>) {
  const shapes = boxes.filter((el) => el.type === "rectangle");
  for (let i = 0; i < shapes.length; i++) {
    for (let j = i + 1; j < shapes.length; j++) {
      const a = shapes[i];
      const b = shapes[j];
      const collides =
        a.x < b.x + b.width &&
        b.x < a.x + a.width &&
        a.y < b.y + b.height &&
        b.y < a.y + a.height;
      if (collides) {
        throw new Error(`"${a.label}" overlaps "${b.label}"`);
      }
    }
  }
}
