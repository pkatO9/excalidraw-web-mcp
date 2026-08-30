import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import { get_scene } from "./toolLayer";
import {
  isTeaching,
  setTutorSinks,
  startLesson,
  stopLesson,
  subscribeTutorSession,
} from "./tutorSession";
import { isSpeechSupported } from "./tutorSpeech";

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

  const teaching = useSyncExternalStore(subscribeTutorSession, isTeaching);

  // The voice is the browser's own, so support is a synchronous local check
  // rather than a question for the backend — same as the mic in useDictation.
  // Browsers without the Web Speech API just don't get the button.
  const available = useMemo(() => isSpeechSupported(), []);

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
