import { DEFAULT_ELEMENT_PROPS, ROUNDNESS } from "@excalidraw/common";
import { newElementWith } from "@excalidraw/element";

import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
} from "@excalidraw/excalidraw";

import type { ExcalidrawElementSkeleton } from "@excalidraw/element/transform";
import type { ExcalidrawElement } from "@excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { layoutGraph } from "./layout";

import { startLesson } from "./tutorSession";

/**
 * The "tool layer": the only code that touches the live Excalidraw scene.
 *
 * These functions run in the browser because `excalidrawAPI` is an in-memory
 * imperative handle on the mounted editor — it cannot be reached from the
 * backend. The backend decides *which* tool to call; this file performs it.
 *
 * The Claude `tool_use` schemas that describe these functions to the model are
 * mirrored in `server/src/toolSchemas.js` (that copy is what is actually sent
 * over the wire). Each schema is repeated in the JSDoc here so this file is a
 * self-contained, paste-ready reference.
 */

/**
 * Styling is opt-in. Anything omitted keeps Excalidraw's default (black stroke,
 * transparent fill), which is what an uncoloured diagram should look like.
 */
export type ElementStyle = {
  strokeColor?: string;
  backgroundColor?: string;
  fillStyle?: "solid" | "hachure" | "cross-hatch";
};

export type SceneElementSummary = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
  /** Reported only when styled, so the model can match an existing palette. */
  strokeColor?: string;
  backgroundColor?: string;
  /** For arrows only: the ids this arrow is actually bound to (null if loose). */
  startBinding?: string | null;
  endBinding?: string | null;
};

export type ToolName =
  | "get_scene"
  | "add_rectangle"
  | "add_text"
  | "bind_arrow"
  | "create_diagram"
  | "set_style"
  | "remove_element"
  | "teach_diagram";

const round = (n: number) => Math.round(n * 100) / 100;

const centerOf = (el: ExcalidrawElement) => ({
  x: el.x + el.width / 2,
  y: el.y + el.height / 2,
});

/**
 * Pick the point on `from`'s outline that an arrow to `to` should leave from.
 *
 * Excalidraw's "orbit" binding stores an anchor as a `fixedPoint`, normalised
 * against the shape's box: [(px - x) / width, (py - y) / height]. A fixedPoint
 * of [0.5, 0.5] is the shape's centre — which is what you get if you seed the
 * arrow centre-to-centre, and it makes the arrow start inside the box and
 * skewer it. Anchoring on the boundary instead ([0.5, 1] = bottom centre,
 * [1, 0.5] = right centre, ...) is what produces clean edge-to-edge arrows.
 *
 * We choose the edge from the dominant axis of the vector between centres, the
 * same way a person would: mostly-vertical relationships leave the bottom/top,
 * mostly-horizontal ones leave the right/left.
 */
export type AnchorAxis = "vertical" | "horizontal";

const edgeAnchor = (
  from: ExcalidrawElement,
  to: ExcalidrawElement,
  axis?: AnchorAxis,
  aimAt?: { x: number; y: number },
) => {
  const a = centerOf(from);
  const b = aimAt ?? centerOf(to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;

  // With no axis given, follow the dominant one — right for a loose arrow the
  // user asked for between two arbitrary boxes.
  //
  // A layered diagram pins the axis instead. Left to itself, a widely spaced
  // parent and child would anchor on their SIDES, and the arrow would then run
  // horizontally through the layer, straight across the siblings sitting
  // between them. Forcing bottom-to-top keeps every edge inside the gap
  // between layers, which is what makes a hierarchy readable — and is how dot
  // and Mermaid draw them.
  const vertical = axis ? axis === "vertical" : Math.abs(dy) >= Math.abs(dx);

  if (vertical) {
    return dy >= 0
      ? { x: a.x, y: from.y + from.height }
      : { x: a.x, y: from.y };
  }
  return dx >= 0 ? { x: from.x + from.width, y: a.y } : { x: from.x, y: a.y };
};

/**
 * Every mutation is written back through `updateScene`, which is the supported
 * way to replace scene contents. We build on `getSceneElementsIncludingDeleted`
 * so that previously-deleted elements are not silently resurrected or dropped —
 * Excalidraw keeps tombstones around for history and collaboration.
 */
const commit = (
  api: ExcalidrawImperativeAPI,
  elements: readonly ExcalidrawElement[],
) => {
  api.updateScene({
    elements,
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
};

/** Clear space required between two boxes, and the grid the search snaps to. */
const PLACEMENT_GAP = 40;
const PLACEMENT_STEP = 20;
const PLACEMENT_MAX_RINGS = 60;

type Box = { x: number; y: number; width: number; height: number };

/**
 * Things a new box must not land on. Arrows and lines are excluded — they route
 * between shapes, so treating them as obstacles would wall off the canvas.
 */
const obstaclesFor = (api: ExcalidrawImperativeAPI, ignore: Set<string>) =>
  api
    .getSceneElements()
    .filter(
      (el) =>
        !ignore.has(el.id) &&
        el.type !== "arrow" &&
        el.type !== "line" &&
        !(el.type === "text" && el.containerId),
    );

const overlaps = (a: Box, b: Box, gap: number) =>
  a.x < b.x + b.width + gap &&
  b.x < a.x + a.width + gap &&
  a.y < b.y + b.height + gap &&
  b.y < a.y + a.height + gap;

const hits = (box: Box, obstacles: readonly Box[]) =>
  obstacles.filter((el) => overlaps(box, el, PLACEMENT_GAP));

/**
 * Find the closest free position to the one asked for.
 *
 * The model is good at expressing intent ("put the cache to the right of the
 * database") and bad at collision-checking a canvas with thirty elements on it,
 * especially since it issues a whole batch of add_rectangle calls at once and
 * only sees the results afterwards. So the tool layer guarantees the invariant
 * instead: the requested spot is honoured when it is free, and otherwise we
 * search outward on a grid and take the nearest opening. The model's layout
 * intent survives because we always prefer the smallest possible nudge.
 */
const findFreePosition = (
  api: ExcalidrawImperativeAPI,
  box: Box,
  ignore: Set<string> = new Set(),
): { x: number; y: number; movedFrom?: { x: number; y: number } } => {
  const obstacles = obstaclesFor(api, ignore);

  if (hits(box, obstacles).length === 0) {
    return { x: box.x, y: box.y };
  }

  for (let ring = 1; ring <= PLACEMENT_MAX_RINGS; ring++) {
    const span = ring * PLACEMENT_STEP;

    const candidates: { x: number; y: number }[] = [];
    for (let i = -ring; i <= ring; i++) {
      const offset = i * PLACEMENT_STEP;
      candidates.push({ x: box.x + offset, y: box.y + span });
      candidates.push({ x: box.x + offset, y: box.y - span });
      candidates.push({ x: box.x + span, y: box.y + offset });
      candidates.push({ x: box.x - span, y: box.y + offset });
    }

    // Nearest first, so the box ends up as close to the requested spot as the
    // canvas allows rather than at an arbitrary corner of the ring.
    candidates.sort(
      (a, b) =>
        (a.x - box.x) ** 2 +
        (a.y - box.y) ** 2 -
        ((b.x - box.x) ** 2 + (b.y - box.y) ** 2),
    );

    for (const candidate of candidates) {
      if (hits({ ...box, ...candidate }, obstacles).length === 0) {
        return { ...candidate, movedFrom: { x: box.x, y: box.y } };
      }
    }
  }

  // Canvas is implausibly full; place where asked rather than failing the call.
  return { x: box.x, y: box.y };
};

/** Drops undefined keys so we never overwrite a colour with `undefined`. */
const pickStyle = (style: ElementStyle) => {
  const out: Record<string, string> = {};
  if (style.strokeColor) {
    out.strokeColor = style.strokeColor;
  }
  if (style.backgroundColor) {
    out.backgroundColor = style.backgroundColor;
  }
  if (style.fillStyle) {
    out.fillStyle = style.fillStyle;
  }
  return out;
};

const requireLiveElement = (
  api: ExcalidrawImperativeAPI,
  id: string,
  role: string,
): ExcalidrawElement => {
  const el = api.getSceneElements().find((candidate) => candidate.id === id);
  if (!el) {
    throw new Error(
      `${role} "${id}" does not exist on the canvas. Call get_scene to see the current element ids.`,
    );
  }
  return el;
};

/**
 * Arrows can only bind to shapes. Handing `bind_arrow` another arrow used to
 * fault deep inside Excalidraw with "Cannot read properties of undefined",
 * which tells the agent nothing it can act on — so reject it here with a
 * message that names the actual recovery.
 */
const NON_BINDABLE = new Set(["arrow", "line", "freedraw"]);

const requireBindableElement = (
  api: ExcalidrawImperativeAPI,
  id: string,
  role: string,
): ExcalidrawElement => {
  const el = requireLiveElement(api, id, role);
  if (NON_BINDABLE.has(el.type)) {
    throw new Error(
      `${role} "${id}" is ${
        el.type === "arrow" ? "an arrow" : `a ${el.type}`
      }, and arrows can only connect shapes — not other arrows or lines. To change where an existing arrow points, delete it with remove_element and draw a new one with bind_arrow between the two shapes you want.`,
    );
  }
  return el;
};

/**
 * ```json
 * {
 *   "name": "get_scene",
 *   "description": "Read the current Excalidraw canvas. Returns every visible element with its id, type, exact x/y position, width, height and label. Call this before placing anything so new elements can be positioned by arithmetic on real coordinates instead of guesswork.",
 *   "input_schema": { "type": "object", "properties": {}, "required": [] }
 * }
 * ```
 */
export const get_scene = (
  api: ExcalidrawImperativeAPI,
): SceneElementSummary[] => {
  const elements = api.getSceneElements();

  // A container's label is a separate `text` element pointing back via
  // `containerId`. Fold it into the container so the model sees one shape.
  const labelByContainer = new Map<string, string>();
  for (const el of elements) {
    if (el.type === "text" && el.containerId) {
      labelByContainer.set(el.containerId, el.text);
    }
  }

  return elements
    .filter((el) => !(el.type === "text" && el.containerId))
    .map((el) => {
      const summary: SceneElementSummary = {
        id: el.id,
        type: el.type,
        x: round(el.x),
        y: round(el.y),
        width: round(el.width),
        height: round(el.height),
      };

      const label =
        labelByContainer.get(el.id) ??
        (el.type === "text" ? el.text : undefined);
      if (label) {
        summary.label = label;
      }

      // Only surface colours that were actually set, so an uncoloured diagram
      // stays terse but a coloured one gives the model its palette to match.
      if (el.strokeColor !== DEFAULT_ELEMENT_PROPS.strokeColor) {
        summary.strokeColor = el.strokeColor;
      }
      if (el.backgroundColor !== DEFAULT_ELEMENT_PROPS.backgroundColor) {
        summary.backgroundColor = el.backgroundColor;
      }

      if (el.type === "arrow") {
        summary.startBinding = el.startBinding?.elementId ?? null;
        summary.endBinding = el.endBinding?.elementId ?? null;
      }

      return summary;
    });
};

/**
 * ```json
 * {
 *   "name": "add_rectangle",
 *   "description": "Add a labelled rectangle at exact canvas coordinates. x/y are the top-left corner. Use it for boxes in an architecture diagram (services, databases, load balancers).",
 *   "input_schema": {
 *     "type": "object",
 *     "properties": {
 *       "x": { "type": "number", "description": "Top-left x coordinate." },
 *       "y": { "type": "number", "description": "Top-left y coordinate." },
 *       "width": { "type": "number", "description": "Width in pixels. Use 180 unless the label needs more." },
 *       "height": { "type": "number", "description": "Height in pixels. Use 80 unless the label needs more." },
 *       "label": { "type": "string", "description": "Text shown centred inside the rectangle." }
 *     },
 *     "required": ["x", "y", "width", "height", "label"]
 *   }
 * }
 * ```
 */
export const add_rectangle = (
  api: ExcalidrawImperativeAPI,
  args: {
    x: number;
    y: number;
    width: number;
    height: number;
    label?: string;
  } & ElementStyle,
) => {
  const { width, height, label, ...style } = args;

  // Resolve a non-overlapping position before creating anything, so the
  // invariant holds even when the model fires a whole batch of adds at once.
  const { x, y, movedFrom } = findFreePosition(api, {
    x: args.x,
    y: args.y,
    width,
    height,
  });

  const created = convertToExcalidrawElements([
    {
      type: "rectangle",
      x,
      y,
      width,
      height,
      // House style for this agent, applied here rather than left to the model
      // so it holds on every box: rounded corners, and a hachure (single-line
      // diagonal) fill that keeps the hand-drawn look once a colour is set.
      // `pickStyle` is spread after, so an explicit fillStyle still wins.
      roundness: { type: ROUNDNESS.ADAPTIVE_RADIUS },
      fillStyle: "hachure",
      ...pickStyle(style),
      ...(label ? { label: { text: label } } : {}),
    } as ExcalidrawElementSkeleton,
  ]);

  commit(api, [...api.getSceneElementsIncludingDeleted(), ...created]);

  const container = created.find((el) => el.type === "rectangle")!;

  return {
    id: container.id,
    type: container.type,
    x: round(container.x),
    y: round(container.y),
    width: round(container.width),
    height: round(container.height),
    ...(label ? { label } : {}),
    ...(movedFrom
      ? {
          moved_from: movedFrom,
          note: `(${movedFrom.x}, ${
            movedFrom.y
          }) was already occupied, so the box was placed at (${round(
            container.x,
          )}, ${round(
            container.y,
          )}) — the nearest free spot. Use these coordinates when positioning anything relative to it.`,
        }
      : {}),
  };
};

/**
 * ```json
 * {
 *   "name": "add_text",
 *   "description": "Add a standalone text element at exact coordinates — for diagram titles, captions or notes that are NOT attached to a shape. To label a shape, pass the label to add_rectangle instead.",
 *   "input_schema": {
 *     "type": "object",
 *     "properties": {
 *       "x": { "type": "number", "description": "Top-left x coordinate." },
 *       "y": { "type": "number", "description": "Top-left y coordinate." },
 *       "text": { "type": "string", "description": "The text to render." }
 *     },
 *     "required": ["x", "y", "text"]
 *   }
 * }
 * ```
 */
export const add_text = (
  api: ExcalidrawImperativeAPI,
  args: { x: number; y: number; text: string },
) => {
  const created = convertToExcalidrawElements([
    { type: "text", x: args.x, y: args.y, text: args.text },
  ]);

  commit(api, [...api.getSceneElementsIncludingDeleted(), ...created]);

  const textEl = created.find((el) => el.type === "text")!;
  return {
    id: textEl.id,
    type: textEl.type,
    x: round(textEl.x),
    y: round(textEl.y),
    width: round(textEl.width),
    height: round(textEl.height),
    text: args.text,
  };
};

/**
 * ```json
 * {
 *   "name": "bind_arrow",
 *   "description": "Draw an arrow from one existing element to another, using Excalidraw's native binding so it snaps to both shapes' edges and stays attached when they move. Pass element ids from get_scene — never coordinates.",
 *   "input_schema": {
 *     "type": "object",
 *     "properties": {
 *       "source_id": { "type": "string", "description": "id of the element the arrow starts at." },
 *       "target_id": { "type": "string", "description": "id of the element the arrow points to." }
 *     },
 *     "required": ["source_id", "target_id"]
 *   }
 * }
 * ```
 *
 * Implementation note: rather than hand-computing `startBinding`/`endBinding`
 * (focus + gap are non-trivial), we hand the two *existing* elements plus an
 * arrow skeleton to Excalidraw's own `convertToExcalidrawElements` with
 * `regenerateIds: false`. That runs the editor's real binding code
 * (`bindBindingElement`) against them, so the arrow snaps to the shape
 * outlines exactly as a hand-drawn one would, and both shapes get the arrow
 * appended to their `boundElements`.
 */
export const bind_arrow = (
  api: ExcalidrawImperativeAPI,
  args: {
    source_id: string;
    target_id: string;
    axis?: AnchorAxis;
    /** Absolute bend points, from the layout engine's reserved corridors. */
    waypoints?: { x: number; y: number }[];
  },
) => {
  const { source_id, target_id, axis, waypoints } = args;

  if (source_id === target_id) {
    throw new Error("source_id and target_id must be different elements.");
  }

  const source = requireBindableElement(api, source_id, "source_id");
  const target = requireBindableElement(api, target_id, "target_id");

  // Seed the arrow between the two shapes' EDGES, not their centres. The binding
  // code derives each fixedPoint from the endpoint we hand it, so seeding at the
  // centre produces a [0.5, 0.5] anchor and an arrow that starts inside the box
  // and crosses over it. Seeding on the outline yields boundary anchors
  // ([0.5, 1], [0, 0.5], ...) and a clean edge-to-edge arrow.
  const route = waypoints ?? [];
  // Aim the anchors at the first/last bend rather than at the far box, so a
  // routed arrow leaves in the direction it is actually going.
  const from = edgeAnchor(source, target, axis, route[0]);
  const to = edgeAnchor(target, source, axis, route[route.length - 1]);

  const converted = convertToExcalidrawElements(
    [
      { ...source },
      { ...target },
      {
        type: "arrow",
        x: from.x,
        y: from.y,
        width: to.x - from.x,
        height: to.y - from.y,
        // `points` must be given explicitly. Excalidraw derives its default from
        // `element.width || 100`, so a perfectly vertical arrow (width 0) would
        // silently be given a 100px horizontal kink. The skeleton is spread over
        // those defaults, so supplying points here wins.
        points: [
          [0, 0],
          ...route.map((point) => [point.x - from.x, point.y - from.y]),
          [to.x - from.x, to.y - from.y],
        ],
        start: { id: source_id },
        end: { id: target_id },
      },
    ] as ExcalidrawElementSkeleton[],
    { regenerateIds: false },
  );

  const arrow = converted.find((el) => el.type === "arrow");
  if (!arrow) {
    throw new Error("Failed to create the arrow element.");
  }

  // `converted` holds rebuilt copies of source/target (now carrying the arrow in
  // their `boundElements`) plus the new arrow. Swap the rebuilt copies over the
  // originals by id and append the arrow.
  const rebuiltById = new Map(converted.map((el) => [el.id, el]));
  const next = api
    .getSceneElementsIncludingDeleted()
    .map((el) => rebuiltById.get(el.id) ?? el);

  commit(api, [...next, arrow]);

  return {
    id: arrow.id,
    type: "arrow",
    source_id,
    target_id,
    bound: Boolean((arrow as any).startBinding && (arrow as any).endBinding),
  };
};

/**
 * ```json
 * {
 *   "name": "set_style",
 *   "description": "Apply colours to elements that are ALREADY on the canvas. Use this when the user asks to colour, highlight or restyle an existing diagram — it edits in place, so positions, labels and arrow bindings are preserved. Pass several ids at once to give a whole tier the same colour.",
 *   "input_schema": {
 *     "type": "object",
 *     "properties": {
 *       "ids": { "type": "array", "items": { "type": "string" }, "description": "Element ids from get_scene to restyle." },
 *       "backgroundColor": { "type": "string", "description": "Fill colour as a hex string, or \"transparent\" to clear it." },
 *       "strokeColor": { "type": "string", "description": "Border/line colour as a hex string." },
 *       "fillStyle": { "type": "string", "enum": ["solid", "hachure", "cross-hatch"], "description": "How the fill is drawn. Defaults to solid." }
 *     },
 *     "required": ["ids"]
 *   }
 * }
 * ```
 */
export const set_style = (
  api: ExcalidrawImperativeAPI,
  args: { ids: string[] } & ElementStyle,
) => {
  const { ids, ...style } = args;

  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error("`ids` must be a non-empty array of element ids.");
  }

  const patch = pickStyle(style);
  if (Object.keys(patch).length === 0) {
    throw new Error(
      "Nothing to apply: pass at least one of backgroundColor, strokeColor or fillStyle.",
    );
  }

  // Validate up front so a typo'd id fails loudly rather than silently no-op'ing.
  const wanted = new Set(ids);
  for (const id of wanted) {
    requireLiveElement(api, id, "id");
  }

  const next = api
    .getSceneElementsIncludingDeleted()
    .map((el) => (wanted.has(el.id) ? newElementWith(el, patch) : el));

  commit(api, next);

  return { styled_ids: [...wanted], applied: patch };
};

export type DiagramShape = "rectangle" | "diamond" | "ellipse";

/** Roughly how wide a box must be for its label not to wrap awkwardly. */
const widthForLabel = (label: string, shape: DiagramShape) => {
  const base = Math.max(180, Math.ceil(label.length * 9) + 48);
  // A diamond only has its full width at the vertical midpoint, so text needs
  // noticeably more room than the same label in a rectangle.
  return shape === "diamond" ? Math.round(base * 1.5) : base;
};

const heightForShape = (shape: DiagramShape) =>
  shape === "diamond" ? 110 : 80;

/**
 * ```json
 * {
 *   "name": "create_diagram",
 *   "description": "Draw a whole diagram in one call from its STRUCTURE — the boxes and what connects to what — and let the layout engine decide the geometry. Use this for any request that means building a diagram or a subsystem, rather than adding boxes one at a time. Placing boxes individually cannot avoid arrows crossing them, because when each box is positioned the connections it will carry do not exist yet; this tool knows the whole graph up front, so it can rank the nodes, order them to minimise crossings, and route long arrows around whatever sits between. Keep add_rectangle and bind_arrow for small edits to a diagram that already exists.",
 *   "input_schema": {
 *     "type": "object",
 *     "properties": {
 *       "nodes": {
 *         "type": "array",
 *         "description": "Every box in the diagram.",
 *         "items": {
 *           "type": "object",
 *           "properties": {
 *             "key": { "type": "string", "description": "Short id used only to describe edges, e.g. \"db\". Not shown." },
 *             "label": { "type": "string", "description": "Text shown in the box." },
 *             "shape": { "type": "string", "enum": ["rectangle", "diamond", "ellipse"], "description": "rectangle for a service or store (default), diamond for a decision or branch, ellipse for a start or end point." }
 *           },
 *           "required": ["key", "label"]
 *         }
 *       },
 *       "edges": {
 *         "type": "array",
 *         "description": "Connections, pointing from upstream to downstream.",
 *         "items": {
 *           "type": "object",
 *           "properties": {
 *             "from": { "type": "string", "description": "key of the source node." },
 *             "to": { "type": "string", "description": "key of the target node." }
 *           },
 *           "required": ["from", "to"]
 *         }
 *       },
 *       "direction": { "type": "string", "enum": ["TB", "LR"], "description": "TB (default) stacks the flow downward; LR runs it left to right. Prefer TB for architectures, LR for short pipelines." },
 *       "replace": { "type": "boolean", "description": "true clears the canvas first. Use it when the user asks to start over or replace what is there." }
 *     },
 *     "required": ["nodes", "edges"]
 *   }
 * }
 * ```
 */
export const create_diagram = (
  api: ExcalidrawImperativeAPI,
  args: {
    nodes: { key: string; label: string; shape?: DiagramShape }[];
    edges: { from: string; to: string }[];
    direction?: "TB" | "LR";
    replace?: boolean;
  },
) => {
  const { nodes, edges = [], direction = "TB", replace = false } = args;

  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new Error("`nodes` must be a non-empty array.");
  }

  const seen = new Set<string>();
  for (const node of nodes) {
    if (!node?.key || !node?.label) {
      throw new Error("Every node needs a `key` and a `label`.");
    }
    if (seen.has(node.key)) {
      throw new Error(`Duplicate node key "${node.key}".`);
    }
    seen.add(node.key);
  }
  for (const edge of edges) {
    for (const end of [edge?.from, edge?.to]) {
      if (!seen.has(end)) {
        throw new Error(
          `Edge refers to unknown node key "${end}". Every edge must name keys from \`nodes\`.`,
        );
      }
    }
  }

  const sized = nodes.map((node) => {
    const shape = node.shape ?? "rectangle";
    return {
      ...node,
      shape,
      width: widthForLabel(node.label, shape),
      height: heightForShape(shape),
    };
  });

  // Start clear of anything already drawn, so a new diagram never lands on top
  // of an old one.
  const existing = replace ? [] : api.getSceneElements();
  const lowestFree = existing.length
    ? Math.max(...existing.map((el) => el.y + el.height)) + 120
    : 120;

  const { placements, routes } = layoutGraph(
    sized.map(({ key, width, height }) => ({ key, width, height })),
    edges,
    { direction, originY: lowestFree },
  );

  const skeletons = sized.map((node) => {
    const at = placements.get(node.key)!;
    return {
      type: node.shape,
      x: at.x,
      y: at.y,
      width: node.width,
      height: node.height,
      roundness: { type: ROUNDNESS.ADAPTIVE_RADIUS },
      fillStyle: "hachure",
      label: { text: node.label },
    };
  });

  const created = convertToExcalidrawElements(
    skeletons as ExcalidrawElementSkeleton[],
  );

  const base = replace
    ? api
        .getSceneElementsIncludingDeleted()
        .map((el) =>
          el.isDeleted ? el : newElementWith(el, { isDeleted: true }),
        )
    : api.getSceneElementsIncludingDeleted();

  commit(api, [...base, ...created]);

  // Map layout keys to the ids the canvas actually assigned.
  const idOf = new Map<string, string>();
  const containers = created.filter((el) => el.type !== "text");
  sized.forEach((node, index) => {
    idOf.set(node.key, containers[index].id);
  });

  // The layout is layered, so every arrow leaves the bottom and enters the top
  // (or right/left when LR). Letting each arrow pick its own dominant axis
  // would send widely spaced pairs out sideways, straight across their
  // neighbours.
  const axis: AnchorAxis = direction === "TB" ? "vertical" : "horizontal";

  let bound = 0;
  const failures: string[] = [];
  edges.forEach((edge, index) => {
    try {
      bind_arrow(api, {
        source_id: idOf.get(edge.from)!,
        target_id: idOf.get(edge.to)!,
        axis,
        waypoints: routes[index],
      });
      bound++;
    } catch (error) {
      failures.push(
        `${edge.from}->${edge.to}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });

  return {
    nodes: sized.map((node) => ({
      key: node.key,
      id: idOf.get(node.key),
      label: node.label,
      ...placements.get(node.key)!,
    })),
    arrows_bound: bound,
    ...(failures.length ? { failed_edges: failures } : {}),
  };
};

/**
 * ```json
 * {
 *   "name": "remove_element",
 *   "description": "Delete an element by id. Deleting a shape also removes its label and any arrows bound to it, so those arrows disappear automatically — do NOT also call remove_element for them. When the user asks to delete several elements, issue one call per shape and leave the connecting arrows out. Calling it for something that has already gone is a harmless no-op.",
 *   "input_schema": {
 *     "type": "object",
 *     "properties": {
 *       "id": { "type": "string", "description": "id of the element to delete, from get_scene." }
 *     },
 *     "required": ["id"]
 *   }
 * }
 * ```
 */
export const remove_element = (
  api: ExcalidrawImperativeAPI,
  args: { id: string },
) => {
  const { id } = args;

  const target = api.getSceneElements().find((el) => el.id === id);

  if (!target) {
    // Deleting a shape cascades to the arrows bound to it, so an agent working
    // through a multi-selection will routinely reach an arrow that already went
    // with its shape. That is a no-op, not a failure — reporting it as an error
    // makes a correct deletion look broken. An id we have never seen is still a
    // real mistake, so those keep throwing.
    const everExisted = api
      .getSceneElementsIncludingDeleted()
      .some((el) => el.id === id);

    if (everExisted) {
      return {
        removed_ids: [],
        already_removed: true,
        note: `"${id}" was already removed — most likely an arrow that was deleted along with a shape it was bound to. Nothing left to do.`,
      };
    }

    throw new Error(
      `id "${id}" does not exist on the canvas. Call get_scene to see the current element ids.`,
    );
  }

  // Deleting a shape must also delete what hangs off it, otherwise Excalidraw
  // is left with a label pointing at nothing and arrows bound to a ghost.
  const doomed = new Set<string>([id]);
  for (const bound of target.boundElements ?? []) {
    doomed.add(bound.id);
  }
  for (const el of api.getSceneElements()) {
    if (
      el.type === "arrow" &&
      (el.startBinding?.elementId === id || el.endBinding?.elementId === id)
    ) {
      doomed.add(el.id);
    }
  }

  const next = api
    .getSceneElementsIncludingDeleted()
    .map((el) =>
      doomed.has(el.id) ? newElementWith(el, { isDeleted: true }) : el,
    );

  commit(api, next);

  return { removed_ids: [...doomed] };
};

/**
 * Start a spoken walkthrough of the current diagram.
 *
 * @remarks
 * Unlike every other tool here this one has no effect on the scene — it starts
 * a *process*: the tutor fetches a lesson, narrates it, and traces a cursor
 * over each element as it speaks.
 *
 * It returns as soon as the lesson starts, because `executeTool` is
 * synchronous and a lesson runs for a minute or more; blocking here would
 * freeze the agent loop for the whole narration. The model is told in its tool
 * description that the return value means "started", not "finished".
 *
 * Preconditions throw so `executeTool` reports them as a tool error the model
 * can act on (an empty canvas → draw something first).
 *
 * ```jsonc
 * {
 *   "name": "teach_diagram",
 *   "input_schema": { "type": "object", "properties": {}, "required": [] }
 * }
 * ```
 */
export const teach_diagram = (api: ExcalidrawImperativeAPI) =>
  startLesson(api, () => get_scene(api));

/** Dispatch table used by the chat sidebar to run whatever the model asked for. */
export const TOOL_IMPLEMENTATIONS: Record<
  ToolName,
  (api: ExcalidrawImperativeAPI, input: any) => unknown
> = {
  get_scene: (api) => get_scene(api),
  add_rectangle: (api, input) => add_rectangle(api, input),
  add_text: (api, input) => add_text(api, input),
  bind_arrow: (api, input) => bind_arrow(api, input),
  create_diagram: (api, input) => create_diagram(api, input),
  set_style: (api, input) => set_style(api, input),
  remove_element: (api, input) => remove_element(api, input),
  teach_diagram: (api) => teach_diagram(api),
};

export const executeTool = (
  api: ExcalidrawImperativeAPI,
  name: string,
  input: unknown,
): { ok: true; result: unknown } | { ok: false; error: string } => {
  const impl = TOOL_IMPLEMENTATIONS[name as ToolName];
  if (!impl) {
    return { ok: false, error: `Unknown tool "${name}".` };
  }
  try {
    return { ok: true, result: impl(api, input) };
  } catch (error) {
    // Errors are returned rather than thrown so the agent loop can feed them
    // back to the model as a tool_result and let it recover.
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};
