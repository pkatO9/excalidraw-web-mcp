import { resolvablePromise } from "@excalidraw/common";
import { Excalidraw } from "@excalidraw/excalidraw";
import { render } from "@excalidraw/excalidraw/tests/test-utils";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { executeTool, get_scene } from "../ai-agent/toolLayer";

/**
 * End-to-end: real Excalidraw canvas + real backend + real model.
 *
 * Skipped automatically unless the backend is running, so `yarn test` stays
 * green for anyone who has not configured a provider.
 *   cd server && npm start
 */
const API_BASE = process.env.AGENT_API ?? "http://localhost:8787";

const health = await fetch(`${API_BASE}/api/health`)
  .then((r) => (r.ok ? r.json() : null))
  .catch(() => null);
const backendUp = Boolean(health);

// `describe.skipIf` is not in the ambient test typings here, so branch manually.
const describeE2E = backendUp ? describe : describe.skip;
// The tutor's voice is the browser's, so the backend only has to be up.
const describeTutorE2E = describeE2E;

describeE2E("AI agent end-to-end", () => {
  let api: ExcalidrawImperativeAPI;

  const history: any[] = [];

  const ask = async (text: string) => {
    // Bind the API to a const before the loop below: `api` is assigned in
    // beforeAll, and closures declared inside a loop may not reference it.
    const editor = api;

    history.push({ role: "user", content: text });
    const scene = get_scene(editor);

    for (let turn = 0; turn < 12; turn++) {
      const response = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: history,
          ...(turn === 0 ? { scene } : {}),
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error);
      }

      history.push(data.message);
      if (data.type === "final") {
        return data.message.content as string;
      }

      history.push({
        role: "tool",
        results: data.message.toolCalls.map((call: any) => {
          const outcome = executeTool(editor, call.name, call.input);
          return {
            id: call.id,
            name: call.name,
            content: outcome.ok
              ? JSON.stringify(outcome.result)
              : `Error: ${outcome.error}`,
            ...(outcome.ok ? {} : { isError: true }),
          };
        }),
      });
    }
    throw new Error("agent loop did not terminate");
  };

  beforeAll(async () => {
    const apiPromise = resolvablePromise<ExcalidrawImperativeAPI>();
    await render(
      <Excalidraw onExcalidrawAPI={(a) => apiPromise.resolve(a as any)} />,
    );
    api = await apiPromise;
  });

  it("draws a 3-tier architecture, then extends it incrementally", async () => {
    // ---- turn 1: from an empty canvas -----------------------------------
    await ask(
      "draw a 3-tier architecture with a load balancer, two app servers, and a database",
    );

    let scene = get_scene(api);
    const boxes = scene.filter((el) => el.type === "rectangle");
    const arrows = scene.filter((el) => el.type === "arrow");

    expect(boxes.length).toBeGreaterThanOrEqual(4);
    expect(arrows.length).toBeGreaterThanOrEqual(3);

    // every arrow is bound at BOTH ends to real elements — the whole point
    const ids = new Set(scene.map((el) => el.id));
    for (const arrow of arrows) {
      expect(arrow.startBinding).toBeTruthy();
      expect(arrow.endBinding).toBeTruthy();
      expect(ids.has(arrow.startBinding!)).toBe(true);
      expect(ids.has(arrow.endBinding!)).toBe(true);
    }

    // house style survives a real agent run: rounded corners, hachure fill,
    // and nothing coloured because colour was never asked for
    for (const raw of api
      .getSceneElements()
      .filter((el) => el.type === "rectangle") as any[]) {
      expect(raw.roundness).toEqual({ type: 3 });
      expect(raw.fillStyle).toBe("hachure");
      expect(raw.backgroundColor).toBe("transparent");
    }

    // arrows must terminate ON the shape outlines, never inside a box
    const rawArrows = api
      .getSceneElements()
      .filter((el) => el.type === "arrow") as any[];
    for (const arrow of rawArrows) {
      const first = arrow.points[0];
      const last = arrow.points[arrow.points.length - 1];
      for (const point of [
        { x: arrow.x + first[0], y: arrow.y + first[1] },
        { x: arrow.x + last[0], y: arrow.y + last[1] },
      ]) {
        for (const box of boxes) {
          const inside =
            point.x > box.x + 1 &&
            point.x < box.x + box.width - 1 &&
            point.y > box.y + 1 &&
            point.y < box.y + box.height - 1;
          if (inside) {
            throw new Error(
              `arrow endpoint (${point.x}, ${point.y}) is inside "${box.label}"`,
            );
          }
        }
      }
    }

    // the diagram is actually laid out, not stacked on one spot
    expect(new Set(boxes.map((b) => `${b.x},${b.y}`)).size).toBe(boxes.length);
    expectNoOverlaps(boxes);

    // ---- turn 2: incremental, must use positions from the live scene ----
    const before = boxes.length;
    await ask("now add a cache next to the database");

    scene = get_scene(api);
    const after = scene.filter((el) => el.type === "rectangle");
    expect(after.length).toBe(before + 1);
    expectNoOverlaps(after);

    const cache = after.find((b) => /cache/i.test(b.label ?? ""));
    const database = after.find((b) => /database|db/i.test(b.label ?? ""));
    expect(cache).toBeDefined();
    expect(database).toBeDefined();

    // "next to" => same row as the database, and genuinely adjacent to it
    expect(Math.abs(cache!.y - database!.y)).toBeLessThan(40);
    const gap = Math.abs(cache!.x - database!.x) - database!.width;
    expect(gap).toBeGreaterThan(0);
    expect(gap).toBeLessThan(400);
  }, 300000);
});

describeTutorE2E("AI tutor end-to-end", () => {
  let api: ExcalidrawImperativeAPI;

  beforeAll(async () => {
    const apiPromise = resolvablePromise<ExcalidrawImperativeAPI>();
    await render(
      <Excalidraw onExcalidrawAPI={(a) => apiPromise.resolve(a as any)} />,
    );
    api = await apiPromise;

    // A small but real diagram to teach.
    const lb = executeTool(api, "add_rectangle", {
      x: 200,
      y: 120,
      width: 180,
      height: 80,
      label: "Load Balancer",
    }) as any;
    const db = executeTool(api, "add_rectangle", {
      x: 200,
      y: 320,
      width: 180,
      height: 80,
      label: "Database",
    }) as any;
    executeTool(api, "bind_arrow", {
      source_id: lb.result.id,
      target_id: db.result.id,
    });
  });

  it("produces a lesson whose every segment points at real elements", async () => {
    const scene = get_scene(api);
    const response = await fetch(`${API_BASE}/api/tutor/lesson`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scene }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error);
    }

    const { lesson } = data;
    expect(lesson.intro.length).toBeGreaterThan(0);
    expect(lesson.closing.length).toBeGreaterThan(0);
    expect(lesson.segments.length).toBeGreaterThan(0);

    const ids = new Set(scene.map((el) => el.id));
    for (const segment of lesson.segments) {
      expect(segment.narration.length).toBeGreaterThan(0);
      expect(segment.elementIds.length).toBeGreaterThan(0);
      for (const id of segment.elementIds) {
        expect(ids.has(id)).toBe(true);
      }
    }
  }, 300000);
});

function expectNoOverlaps(boxes: ReturnType<typeof get_scene>) {
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const overlaps =
        a.x < b.x + b.width &&
        b.x < a.x + a.width &&
        a.y < b.y + b.height &&
        b.y < a.y + a.height;
      if (overlaps) {
        throw new Error(`"${a.label}" overlaps "${b.label}"`);
      }
    }
  }
}
