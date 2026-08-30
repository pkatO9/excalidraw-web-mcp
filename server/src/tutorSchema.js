import { z } from "zod";

/**
 * Zod schemas for the tutor endpoints.
 *
 * Two kinds of untrusted input meet here: request bodies from the browser, and
 * the walkthrough the model returns from its forced tool call. The model is as
 * untrusted as any client — it can hallucinate ids, return empty segments, or
 * skip fields — so its output goes through the same strict parsing.
 *
 * The scene schema is deliberately an explicit allowlist (zod's default strip
 * behaviour), NOT passthrough: everything in `scene` is stringified into a
 * paid model prompt, so unknown fields are dropped and every string is capped.
 * Combined with the array cap, this bounds how much prompt a single
 * unauthenticated request can buy.
 */

/** Longest a single spoken narration chunk may be. */
export const MAX_NARRATION_CHARS = 5000;

/** Most elements one lesson request may describe. */
export const MAX_SCENE_ELEMENTS = 300;

const MAX_LABEL_CHARS = 500;

/**
 * One element as reported by the frontend's get_scene — only the fields the
 * tutor prompt actually needs. Unknown keys are stripped.
 */
const sceneElementSchema = z.object({
  id: z.string().min(1).max(100),
  type: z.string().min(1).max(50),
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite(),
  height: z.number().finite(),
  label: z.string().max(MAX_LABEL_CHARS).optional(),
  strokeColor: z.string().max(50).optional(),
  backgroundColor: z.string().max(50).optional(),
  startBinding: z.string().max(100).nullable().optional(),
  endBinding: z.string().max(100).nullable().optional(),
});

/** Body of POST /api/tutor/lesson. An empty canvas has nothing to teach. */
export const lessonRequestSchema = z.object({
  scene: z.array(sceneElementSchema).min(1).max(MAX_SCENE_ELEMENTS),
  provider: z.enum(["anthropic", "azure"]).optional(),
});

/** The model's `present_walkthrough` tool-call input. */
export const walkthroughSchema = z.object({
  intro: z.string().min(1),
  segments: z
    .array(
      z.object({
        elementIds: z.array(z.string().min(1)).min(1),
        narration: z.string().min(1).max(MAX_NARRATION_CHARS),
      }),
    )
    .min(1),
  closing: z.string().min(1),
});
