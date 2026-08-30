import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import { useCallback, useEffect, useRef, useState } from "react";

import { API_BASE } from "./config";
import { get_scene } from "./toolLayer";
import { playLesson } from "./tutorPlayer";

import type { ChatEntry } from "./types/chat";
import type { TutorLesson } from "./types/tutor";

/**
 * The Teach button and the tutor session it drives.
 *
 * Self-contained by design: it reads the canvas through useExcalidrawAPI and
 * owns its whole lifecycle (capability check, lesson fetch, playback, stop).
 * The sidebar only receives what belongs to the sidebar — transcript entries
 * and the finished lesson for the chat history — so no tutor state is threaded
 * through it.
 *
 * The button renders only when the backend reports TTS support; while a lesson
 * plays it becomes Stop. Playback lives behind an AbortController kept in a
 * ref: stopping (button, teardown) is an event-handler concern, never an
 * effect watching state.
 */

type TutorControlsProps = {
  /** Append a transcript entry (narration lines, errors). */
  onEntry: (entry: ChatEntry) => void;
  /** Record the finished walkthrough in the chat history for follow-ups. */
  onAssistantMessage: (content: string) => void;
  /** Lets the composer trigger a lesson when the user types "teach". */
  teachRef?: React.MutableRefObject<(() => void) | null>;
};

/** The full walkthrough as one block of text, for the chat history. */
const lessonTranscript = (lesson: TutorLesson) =>
  [lesson.intro, ...lesson.segments.map((s) => s.narration), lesson.closing]
    .filter((line) => line.trim().length > 0)
    .join(" ");

const fetchLesson = async (
  scene: ReturnType<typeof get_scene>,
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
  let data: any;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw new Error(data?.error || `The lesson request failed (${response.status}).`);
  }
  if (!data?.lesson?.segments?.length) {
    throw new Error("The lesson came back empty.");
  }
  return data.lesson;
};

export const TutorControls = ({
  onEntry,
  onAssistantMessage,
  teachRef,
}: TutorControlsProps) => {
  const excalidrawAPI = useExcalidrawAPI();

  const [available, setAvailable] = useState(false);
  const [teaching, setTeaching] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  // Capability check: the Teach button only exists if the backend can speak.
  useEffect(() => {
    const controller = new AbortController();
    fetch(`${API_BASE}/api/health`, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => setAvailable(Boolean(data?.tts)))
      .catch(() => {
        // backend down or unreachable — the button simply stays hidden
      });
    return () => controller.abort();
  }, []);

  // Abort any in-flight lesson when the sidebar unmounts.
  useEffect(
    () => () => {
      controllerRef.current?.abort();
    },
    [],
  );

  const stop = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  const teach = useCallback(async () => {
    // Guard on the ref, not the `teaching` state: two clicks inside one render
    // frame both see the stale state and would start two lessons fighting over
    // the same cursor. The ref is set synchronously below.
    if (controllerRef.current || !excalidrawAPI) {
      return;
    }

    const scene = get_scene(excalidrawAPI);
    if (scene.length === 0) {
      onEntry({
        kind: "error",
        text: "The canvas is empty — draw something first, then ask me to teach.",
      });
      return;
    }

    const controller = new AbortController();
    controllerRef.current = controller;
    setTeaching(true);
    onEntry({ kind: "user", text: "Teach me this diagram" });

    try {
      const lesson = await fetchLesson(scene, controller.signal);
      if (controller.signal.aborted) {
        return;
      }
      await playLesson(excalidrawAPI, lesson, {
        signal: controller.signal,
        onNarration: (text) => onEntry({ kind: "assistant", text }),
      });

      // playLesson resolves quietly on abort, so this must be re-checked:
      // recording the full transcript after a Stop would tell every follow-up
      // question that the whole diagram was explained when it was not.
      if (!controller.signal.aborted) {
        onAssistantMessage(lessonTranscript(lesson));
      }
    } catch (error) {
      // An aborted fetch is the user pressing Stop, not a failure.
      if (!controller.signal.aborted) {
        onEntry({
          kind: "error",
          text: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      setTeaching(false);
      // Only release the slot if this lesson still owns it.
      if (controllerRef.current === controller) {
        controllerRef.current = null;
      }
    }
  }, [excalidrawAPI, onAssistantMessage, onEntry]);

  // Expose teach() to the composer's "teach" keyword without lifting state.
  useEffect(() => {
    if (!teachRef) {
      return;
    }
    teachRef.current = () => void teach();
    return () => {
      teachRef.current = null;
    };
  }, [teach, teachRef]);

  if (!available) {
    return null;
  }

  return (
    <button
      type="button"
      className={`ai-tutor__teach${teaching ? " ai-tutor__teach--on" : ""}`}
      aria-pressed={teaching}
      title={
        teaching
          ? "Stop the lesson"
          : "Analyze the diagram and teach it out loud"
      }
      onClick={teaching ? stop : () => void teach()}
    >
      {teaching ? "Stop" : "Teach"}
    </button>
  );
};
