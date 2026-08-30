import { formatSceneContext } from "./systemPrompt.js";
import { walkthroughSchema } from "./tutorSchema.js";

/**
 * The agentic tutor: turns the current canvas into a spoken lesson.
 *
 * ── How the pieces fit together ────────────────────────────────────────────
 * 1. The browser POSTs the live scene (get_scene output) to /api/tutor/lesson.
 * 2. `runTutorLesson` hands the scene to the chat model with a teaching prompt
 *    and a single FORCED tool call, `present_walkthrough`. Forcing the tool is
 *    what makes the lesson structured data instead of prose: every narration
 *    chunk names the element ids it is about, which is what lets the frontend
 *    point the tutor cursor at those elements while that chunk's audio plays.
 * 3. `sanitizeLesson` validates the model's output like any untrusted input —
 *    shape via zod, then every element id against the real scene. Invented ids
 *    are dropped; a lesson about nothing real is rejected.
 * 4. The browser then narrates the lesson segment by segment using the
 *    browser's own speechSynthesis (see app/ai-agent/tutorSpeech.ts). Speech
 *    is entirely client-side, so this server has no audio concerns at all —
 *    it only produces the lesson text.
 */

/** Upstream call gets a ceiling so a hung provider cannot pin a connection. */
const LESSON_TIMEOUT_MS = 120000;

export const TUTOR_SYSTEM_PROMPT = `You are a patient, engaging tutor. You are given the contents of an Excalidraw canvas — a diagram a student has in front of them — and you teach them what it depicts, out loud, like a teacher at a whiteboard.

Rules for the walkthrough you produce:
- Explain the SYSTEM the diagram depicts — the role each part plays, how data or control flows between them, and why the connections exist. Never narrate raw geometry (no coordinates, sizes, or colours).
- Order the segments by flow: start where requests or data enter (entry points, clients, load balancers), follow the arrows through compute, and end at data stores or sinks. Use each arrow's startBinding/endBinding to derive the flow direction.
- Every segment must reference the real element ids from the scene you were given, in elementIds. Never invent an id. Group elements that play the same role (e.g. two app servers) into one segment.
- Each narration is 1-3 short spoken sentences. Write for the ear, not the page: no markdown, no bullet lists, no ids or labels quoted verbatim unless they read naturally.
- The intro sets up what kind of system this is in one or two sentences. The closing summarises the flow end-to-end in one or two sentences.
- If the diagram is ambiguous, teach the most reasonable reading of it and say so naturally ("this looks like...").`;

/**
 * The forced tool. Anthropic-shaped like TOOL_SCHEMAS; providers rewrap it for
 * their own wire format.
 */
export const WALKTHROUGH_TOOL = {
  name: "present_walkthrough",
  description:
    "Present the full spoken walkthrough of the diagram as ordered segments tied to canvas element ids.",
  input_schema: {
    type: "object",
    properties: {
      intro: {
        type: "string",
        description: "Spoken opening: what kind of system this diagram shows.",
      },
      segments: {
        type: "array",
        description:
          "The walkthrough, ordered by how data/control flows through the system.",
        items: {
          type: "object",
          properties: {
            elementIds: {
              type: "array",
              items: { type: "string" },
              description:
                "Ids of the scene elements this narration is about. Must come from the provided scene.",
            },
            narration: {
              type: "string",
              description: "1-3 spoken sentences about those elements.",
            },
          },
          required: ["elementIds", "narration"],
        },
      },
      closing: {
        type: "string",
        description: "Spoken wrap-up summarising the end-to-end flow.",
      },
    },
    required: ["intro", "segments", "closing"],
  },
};

/**
 * Validate the model's walkthrough against the real scene.
 *
 * Shape first (zod), then references: ids the model invented are dropped, and
 * a segment that loses all its ids is dropped with them. Throws when nothing
 * survives — a lesson about elements that do not exist teaches nothing.
 * Pure: never mutates its input.
 */
export const sanitizeLesson = (rawLesson, scene) => {
  const lesson = walkthroughSchema.parse(rawLesson);
  const knownIds = new Set(scene.map((el) => el.id));

  const segments = lesson.segments
    .map((segment) => ({
      ...segment,
      elementIds: segment.elementIds.filter((id) => knownIds.has(id)),
    }))
    .filter((segment) => segment.elementIds.length > 0);

  if (segments.length === 0) {
    throw new Error(
      "The model's walkthrough referenced no known elements on the canvas.",
    );
  }

  return { ...lesson, segments };
};

/**
 * Ask the chat model for a structured walkthrough of the scene.
 *
 * SECURITY INVARIANT: the tutor is given exactly ONE tool, and it mutates
 * nothing. Element labels reach the prompt unescaped, so a maliciously
 * authored diagram can steer what the tutor says — but with no mutating or
 * fetching tool in reach, the worst case is attacker-chosen narration, which
 * is spoken aloud and rendered as inert React text. Granting the tutor any
 * tool with side effects turns that containment into a real vulnerability;
 * re-review this function if you ever do.
 *
 * @param scene get_scene output, already validated by lessonRequestSchema.
 * @param loadProvider lazy import of a provider module exposing runTurn.
 */
export const runTutorLesson = async (scene, loadProvider) => {
  const { runTurn } = await loadProvider();

  const messages = [
    {
      role: "user",
      content: `${formatSceneContext(
        scene,
      )}\n\n---\n\nTeach me this diagram. Produce the full walkthrough now.`,
    },
  ];

  const result = await runTurn(messages, {
    systemPrompt: TUTOR_SYSTEM_PROMPT,
    tools: [WALKTHROUGH_TOOL],
    forceTool: WALKTHROUGH_TOOL.name,
    timeout: LESSON_TIMEOUT_MS,
  });

  const call = (result.message.toolCalls ?? []).find(
    (candidate) => candidate.name === WALKTHROUGH_TOOL.name,
  );
  if (!call) {
    throw new Error("The model did not produce a walkthrough.");
  }

  return sanitizeLesson(call.input, scene);
};
