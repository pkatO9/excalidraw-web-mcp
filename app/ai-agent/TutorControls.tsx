import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import { useEffect, useState, useSyncExternalStore } from "react";

import { API_BASE } from "./config";
import { get_scene } from "./toolLayer";
import {
  isTeaching,
  setTutorSinks,
  startLesson,
  stopLesson,
  subscribeTutorSession,
} from "./tutorSession";

import type { ChatEntry } from "./types/chat";

/**
 * The Teach/Stop button.
 *
 * The lesson itself lives in `tutorSession`, outside React, because the model
 * can also start one through the `teach_diagram` tool — and tools run from the
 * agent loop, with no access to component state. This component therefore owns
 * none of the lesson: it subscribes to the shared session for its label, and
 * registers where narration should land in the transcript. Clicking Teach and
 * the model calling the tool are the same code path.
 */

type TutorControlsProps = {
  /** Append a transcript entry (narration lines, errors). */
  onEntry: (entry: ChatEntry) => void;
  /** Record the finished walkthrough in the chat history for follow-ups. */
  onAssistantMessage: (content: string) => void;
};

export const TutorControls = ({
  onEntry,
  onAssistantMessage,
}: TutorControlsProps) => {
  const excalidrawAPI = useExcalidrawAPI();
  const [available, setAvailable] = useState(false);

  const teaching = useSyncExternalStore(subscribeTutorSession, isTeaching);

  // Capability check: the Teach button only exists if the backend can speak.
  // (The tool stays callable either way — it just reports the 503 as a tool
  // error, which the model relays.)
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

  // Point the session's output at this transcript for as long as we're mounted.
  useEffect(
    () =>
      setTutorSinks({
        onNarration: (text) => onEntry({ kind: "assistant", text }),
        onError: (text) => onEntry({ kind: "error", text }),
        onComplete: onAssistantMessage,
      }),
    [onEntry, onAssistantMessage],
  );

  // Closing the sidebar mid-lesson should stop the narration, not leave it
  // talking to a transcript nobody can see.
  useEffect(() => stopLesson, []);

  const teach = () => {
    if (!excalidrawAPI) {
      return;
    }
    try {
      startLesson(excalidrawAPI, () => get_scene(excalidrawAPI));
    } catch (error) {
      // Same preconditions the tool reports to the model (empty canvas, or a
      // lesson already running) — here they belong in the transcript.
      onEntry({
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      });
    }
  };

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
      onClick={teaching ? stopLesson : teach}
    >
      {teaching ? "Stop" : "Teach"}
    </button>
  );
};
