import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import {
  hideTutorCursor,
  segmentAnchors,
  showTutorCursor,
  tracePointer,
} from "./tutorCursor";
import { speak } from "./tutorSpeech";

import type { SceneElementSummary } from "./toolLayer";
import type { CursorPoint } from "./tutorCursor";
import type { TutorLesson, TutorPlaybackCallbacks } from "./types/tutor";

/**
 * Lesson playback: sequences intro → segments → closing, keeping three things
 * in sync per chunk — the spoken narration, the tracing cursor, and the
 * transcript.
 *
 * Speech comes from the browser (`tutorSpeech`), so there is no audio to fetch
 * or buffer and nothing to prefetch: each chunk is spoken straight from text.
 * The cost is that an utterance's length is unknowable up front, so the cursor
 * is paced by a words-per-minute estimate and cut short the moment speech
 * actually ends — which keeps it in step even when the estimate is wrong.
 *
 * Aborting (the Stop button, or the sidebar closing) is a user action, not an
 * error: playback resolves quietly, cancels the utterance, and removes the
 * cursor.
 */

/** ~150 spoken words per minute; floor so one-word chunks still get a dwell. */
const MS_PER_WORD = 400;
const MIN_CHUNK_MS = 1200;

export const estimateSpeechMs = (text: string) =>
  Math.max(MIN_CHUNK_MS, text.trim().split(/\s+/).length * MS_PER_WORD);

/**
 * Bring the narrated elements into view. Navigation is a nicety: if the
 * viewport API is unavailable (tests) or the elements vanished mid-lesson,
 * the lesson keeps playing — hence the deliberate swallow.
 */
const focusViewport = (api: ExcalidrawImperativeAPI, elementIds: string[]) => {
  try {
    const wanted = new Set(elementIds);
    const targets = api
      .getSceneElements()
      .filter((element) => wanted.has(element.id));
    if (targets.length > 0) {
      api.setViewport({ target: targets, fit: "none", animation: true });
    }
  } catch {
    // never let viewport navigation break the spoken lesson
  }
};

type LessonChunk = { elementIds: string[]; narration: string };

/** Flatten a lesson into narration chunks; intro/closing point at nothing. */
const toChunks = (lesson: TutorLesson): LessonChunk[] =>
  [
    { elementIds: [], narration: lesson.intro },
    ...lesson.segments,
    { elementIds: [], narration: lesson.closing },
  ].filter((chunk) => chunk.narration.trim().length > 0);

/**
 * Speak one chunk while tracing its elements. Returns when the narration ends,
 * along with where the cursor came to rest so the next chunk glides on from
 * there.
 */
const playChunk = async (
  api: ExcalidrawImperativeAPI,
  chunk: LessonChunk,
  cursorEnabled: boolean,
  signal: AbortSignal,
  cursorFrom: CursorPoint | null,
  readScene: () => SceneElementSummary[],
): Promise<CursorPoint | null> => {
  // Re-read the scene per chunk: the user may move things mid-lesson, and the
  // cursor should point where the element is NOW.
  const anchors = cursorEnabled
    ? segmentAnchors(readScene(), chunk.elementIds)
    : [];

  if (anchors.length > 0) {
    focusViewport(api, chunk.elementIds);
    // Place the cursor before the glide starts: on the very first chunk with
    // elements there is nowhere to glide from, and an unplaced cursor would
    // pop in mid-sentence.
    showTutorCursor(api, cursorFrom ?? anchors[0]);
  }

  // The trace gets its own signal so it stops the moment speech ends, rather
  // than dwelling out the remainder of an estimate that ran long.
  const traceController = new AbortController();
  const forwardAbort = () => traceController.abort();
  signal.addEventListener("abort", forwardAbort);

  try {
    const trace =
      anchors.length > 0
        ? tracePointer(
            api,
            anchors,
            estimateSpeechMs(chunk.narration),
            traceController.signal,
            cursorFrom,
          )
        : Promise.resolve(cursorFrom);
    await speak(chunk.narration, signal);
    traceController.abort();
    return await trace;
  } finally {
    signal.removeEventListener("abort", forwardAbort);
  }
};

export const playLesson = async (
  api: ExcalidrawImperativeAPI,
  lesson: TutorLesson,
  {
    signal,
    onNarration,
    readScene,
  }: TutorPlaybackCallbacks & {
    signal: AbortSignal;
    /**
     * Reads the live scene. Injected rather than imported so this module
     * never depends on the tool layer at runtime — the tool layer imports the
     * tutor session to register `teach_diagram`, and a cycle back into here
     * would be fragile.
     */
    readScene: () => SceneElementSummary[];
  },
) => {
  const chunks = toChunks(lesson);
  if (chunks.length === 0) {
    return;
  }

  // A live collab session owns the collaborators map — never fight it for the
  // cursor. The lesson still plays, just without the pointer. Sampled once at
  // lesson start: a session joined mid-lesson is not detected until the next.
  const cursorEnabled = (api.getAppState().collaborators?.size ?? 0) === 0;

  // Where the cursor rests between chunks, threaded through playChunk so it
  // glides on rather than teleporting — and so it never leaks between lessons.
  let cursorAt: CursorPoint | null = null;

  try {
    for (const chunk of chunks) {
      if (signal.aborted) {
        return;
      }

      onNarration(chunk.narration);
      cursorAt = await playChunk(
        api,
        chunk,
        cursorEnabled,
        signal,
        cursorAt,
        readScene,
      );
    }
  } finally {
    if (cursorEnabled) {
      hideTutorCursor(api);
    }
  }
};
