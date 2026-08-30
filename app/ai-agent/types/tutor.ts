/**
 * Shared shapes for the agentic tutor.
 *
 * The core idea: a lesson is *data, not prose*. Each spoken chunk names the
 * canvas element ids it is about, which is what lets the player point the
 * tutor cursor at exactly those elements for exactly as long as that chunk's
 * audio plays. The backend guarantees every id survives validation against the
 * real scene before a lesson reaches the browser.
 */

/** One spoken chunk plus the canvas elements it talks about. */
export type LessonSegment = {
  /** Ids of scene elements this narration refers to (validated server-side). */
  elementIds: string[];
  /** 1–3 spoken sentences about those elements. */
  narration: string;
};

/** A full walkthrough, as returned by POST /api/tutor/lesson. */
export type TutorLesson = {
  intro: string;
  segments: LessonSegment[];
  closing: string;
};

/** Callbacks the playback engine reports through. */
export type TutorPlaybackCallbacks = {
  /** Called with each narration line as it starts being spoken. */
  onNarration: (text: string) => void;
};
