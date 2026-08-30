import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { API_BASE } from "./config";
import { playLesson } from "./tutorPlayer";

import type { SceneElementSummary } from "./toolLayer";
import type { TutorLesson } from "./types/tutor";

/**
 * The tutor session — at most one lesson at a time, owned outside React.
 *
 * Why this lives outside the component tree: `teach_diagram` is a WebMCP tool,
 * and tools are executed by `executeTool` from the agent loop — plain
 * functions with no access to React context or component state. So the session
 * is a small external store that both entry points drive:
 *
 *     Teach button ──┐
 *                    ├──► startLesson() ──► fetch lesson ──► playLesson()
 *     model tool ────┘
 *
 * Because they share one session, the model cannot start a lesson on top of
 * the button's, and Stop ends whichever one is running. `TutorControls`
 * subscribes with `useSyncExternalStore` for the button's state, and registers
 * the sinks that put narration into the transcript.
 *
 * `startLesson` is deliberately synchronous: it validates, kicks the lesson
 * off, and returns a summary immediately, because the agent loop cannot block
 * for a minute of audio. Failures after that point are reported through the
 * sinks rather than the return value.
 */

/** Where a running lesson reports to. Registered by the UI. */
export type TutorSinks = {
  onNarration: (text: string) => void;
  onError: (message: string) => void;
  /** The finished walkthrough, for the chat history. Not called on abort. */
  onComplete: (transcript: string) => void;
};

let sinks: TutorSinks | null = null;
let controller: AbortController | null = null;
let teaching = false;

const listeners = new Set<() => void>();

const setTeaching = (next: boolean) => {
  if (teaching === next) {
    return;
  }
  teaching = next;
  for (const listener of listeners) {
    listener();
  }
};

/** Subscribe to session changes (useSyncExternalStore). */
export const subscribeTutorSession = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Snapshot for useSyncExternalStore. Returns a primitive on purpose: a fresh
 * object each call would re-render forever.
 */
export const isTeaching = () => teaching;

/** Register where narration goes. Returns an unregister function. */
export const setTutorSinks = (next: TutorSinks) => {
  sinks = next;
  return () => {
    if (sinks === next) {
      sinks = null;
    }
  };
};

/** Stop the running lesson, if any. Safe to call when idle. */
export const stopLesson = () => {
  controller?.abort();
};

/** The full walkthrough as one block of text, for the chat history. */
const lessonTranscript = (lesson: TutorLesson) =>
  [lesson.intro, ...lesson.segments.map((s) => s.narration), lesson.closing]
    .filter((line) => line.trim().length > 0)
    .join(" ");

const fetchLesson = async (
  scene: SceneElementSummary[],
  signal: AbortSignal,
): Promise<TutorLesson> => {
  const response = await fetch(`${API_BASE}/api/tutor/lesson`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scene }),
    signal,
  });

  // Parse defensively: a proxy 502 returns HTML, and a JSON syntax error is a
  // worse thing to show the user than the status.
  let data: { lesson?: TutorLesson; error?: string } | null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw new Error(
      data?.error || `The lesson request failed (${response.status}).`,
    );
  }
  if (!data?.lesson?.segments?.length) {
    throw new Error("The lesson came back empty.");
  }
  return data.lesson;
};

/** The async body of a lesson. Never throws — everything lands in the sinks. */
const runLesson = async (
  api: ExcalidrawImperativeAPI,
  scene: SceneElementSummary[],
  readScene: () => SceneElementSummary[],
  own: AbortController,
) => {
  try {
    const lesson = await fetchLesson(scene, own.signal);
    if (own.signal.aborted) {
      return;
    }

    await playLesson(api, lesson, {
      signal: own.signal,
      readScene,
      onNarration: (text) => sinks?.onNarration(text),
    });

    // playLesson resolves quietly on abort, so this must be re-checked:
    // recording the full transcript after a Stop would tell every follow-up
    // question that the whole diagram was explained when it was not.
    if (!own.signal.aborted) {
      sinks?.onComplete(lessonTranscript(lesson));
    }
  } catch (error) {
    // An aborted fetch is the user pressing Stop, not a failure.
    if (!own.signal.aborted) {
      sinks?.onError(
        error instanceof Error ? error.message : String(error),
      );
    }
  } finally {
    if (controller === own) {
      controller = null;
      setTeaching(false);
    }
  }
};

/** What `teach_diagram` hands back to the model. */
export type LessonStarted = { started: true; elements: number };

/**
 * Begin a lesson about the current canvas.
 *
 * Throws on a precondition failure so `executeTool` turns it into a tool error
 * the model can read and recover from ("the canvas is empty" → draw first).
 *
 * @param readScene supplied by the caller rather than imported, so this module
 *   never imports the tool layer — which imports *this* one to register the
 *   tool, and a runtime cycle between them would be fragile.
 */
export const startLesson = (
  api: ExcalidrawImperativeAPI,
  readScene: () => SceneElementSummary[],
): LessonStarted => {
  if (controller) {
    throw new Error(
      "A lesson is already playing. Stop it before starting another.",
    );
  }

  const scene = readScene();
  if (scene.length === 0) {
    throw new Error(
      "The canvas is empty — there is nothing to teach. Draw something first.",
    );
  }

  const own = new AbortController();
  controller = own;
  setTeaching(true);

  // Deliberately not awaited: the caller (a synchronous tool, or a click)
  // must not block for the length of the narration.
  void runLesson(api, scene, readScene, own);

  return { started: true, elements: scene.length };
};
