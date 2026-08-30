import type {
  Collaborator,
  ExcalidrawImperativeAPI,
  SocketId,
} from "@excalidraw/excalidraw/types";

import type { SceneElementSummary } from "./toolLayer";

/**
 * The tracing cursor: the tutor rendered as a fake collaborator.
 *
 * Excalidraw natively draws a named cursor for every entry in the app state's
 * `collaborators` map — that is how you see a teammate's pointer in a collab
 * room, and how the `?collaborators=N` debug helper fakes a roster. We reuse
 * that: "Tutor" is one synthetic collaborator whose `pointer` this module
 * tweens between the elements currently being narrated. No custom canvas
 * drawing, and the cursor automatically pans/zooms with the scene because it
 * lives in scene coordinates.
 *
 * Limitation (shared with the debug helper): a real collab session owns the
 * collaborators map, so the caller must not enable the cursor when one is
 * active — the player checks `collaborators.size` before using this module.
 */

export const TUTOR_SOCKET_ID = "ai-tutor" as SocketId;

/** Vertical gap between an element's top edge and the cursor tip. */
const ANCHOR_LIFT = 12;

const TUTOR_IDENTITY: Collaborator = {
  id: TUTOR_SOCKET_ID,
  socketId: TUTOR_SOCKET_ID,
  username: "Tutor",
  color: { background: "#d0bfff", stroke: "#6741d9" },
};

/** Scene point the cursor should rest at for one element: top-centre, lifted. */
export type CursorPoint = { x: number; y: number };

/**
 * Where the cursor points for each referenced element, in narration order.
 * Ids not present in the scene are skipped — the backend validates ids, but a
 * stale scene (the user deleted a box mid-lesson) must not crash playback.
 */
export const segmentAnchors = (
  scene: SceneElementSummary[],
  elementIds: string[],
): CursorPoint[] => {
  const byId = new Map(scene.map((el) => [el.id, el]));
  return elementIds
    .map((id) => byId.get(id))
    .filter((el): el is SceneElementSummary => Boolean(el))
    .map((el) => ({ x: el.x + el.width / 2, y: el.y - ANCHOR_LIFT }));
};

export const showTutorCursor = (
  api: ExcalidrawImperativeAPI,
  point: CursorPoint,
) => {
  api.updateScene({
    collaborators: new Map([
      [
        TUTOR_SOCKET_ID,
        {
          ...TUTOR_IDENTITY,
          pointer: { x: point.x, y: point.y, tool: "pointer" as const },
        },
      ],
    ]),
  });
};

export const hideTutorCursor = (api: ExcalidrawImperativeAPI) => {
  api.updateScene({ collaborators: new Map() });
};

/** requestAnimationFrame with a timer fallback for non-browser test envs. */
const nextFrame = (): Promise<number> =>
  new Promise((resolve) =>
    typeof requestAnimationFrame === "function"
      ? requestAnimationFrame(resolve)
      : setTimeout(() => resolve(performance.now()), 16),
  );

const easeInOut = (t: number) =>
  t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;

/**
 * One eased glide between two points. Stops (mid-flight) on abort, returning
 * wherever the cursor actually got to so the caller can continue from there.
 */
const glide = async (
  api: ExcalidrawImperativeAPI,
  from: CursorPoint,
  to: CursorPoint,
  durationMs: number,
  signal: AbortSignal,
): Promise<CursorPoint> => {
  const start = performance.now();
  let current = from;

  while (!signal.aborted) {
    const t = Math.min(1, (performance.now() - start) / durationMs);
    const eased = easeInOut(t);
    current = {
      x: from.x + (to.x - from.x) * eased,
      y: from.y + (to.y - from.y) * eased,
    };
    showTutorCursor(api, current);
    if (t >= 1) {
      break;
    }
    await nextFrame();
  }

  return current;
};

/**
 * Trace the cursor across the segment's anchors for roughly the duration of
 * its narration: each anchor gets an equal share of the time — a short glide
 * in, then a dwell while that part is being spoken. Resolves early (quietly)
 * when the signal aborts; it never rejects, so playback logic stays simple.
 *
 * Returns where the cursor ended up. The caller threads that back in as
 * `from` on the next segment so the cursor glides on from where it rested
 * rather than teleporting — kept as a parameter rather than module state so
 * two lessons can never inherit each other's position.
 */
export const tracePointer = async (
  api: ExcalidrawImperativeAPI,
  anchors: CursorPoint[],
  durationMs: number,
  signal: AbortSignal,
  from?: CursorPoint | null,
): Promise<CursorPoint | null> => {
  if (anchors.length === 0) {
    return from ?? null;
  }

  const perAnchorMs = durationMs / anchors.length;
  // Glides are quick relative to the dwell, so the cursor spends its time
  // resting on the element being talked about, not travelling.
  const glideMs = Math.min(600, perAnchorMs * 0.3);

  let current = from ?? anchors[0];

  for (const anchor of anchors) {
    if (signal.aborted) {
      return current;
    }
    current = await glide(api, current, anchor, glideMs, signal);

    const dwellUntil = performance.now() + (perAnchorMs - glideMs);
    while (!signal.aborted && performance.now() < dwellUntil) {
      await nextFrame();
    }
  }

  return current;
};
