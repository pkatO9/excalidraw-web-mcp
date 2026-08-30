import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { API_BASE } from "./config";
import { get_scene } from "./toolLayer";
import {
  hideTutorCursor,
  segmentAnchors,
  showTutorCursor,
  tracePointer,
} from "./tutorCursor";

import type { CursorPoint } from "./tutorCursor";
import type { TutorLesson, TutorPlaybackCallbacks } from "./types/tutor";

/**
 * Lesson playback: sequences intro → segments → closing, keeping three things
 * in sync per chunk — the spoken audio, the tracing cursor, and the transcript.
 *
 * Pipeline: while chunk N plays, chunk N+1's audio is already being fetched,
 * so the tutor never pauses between sentences. Aborting (the Stop button or
 * unmount) is a user action, not an error: playback resolves quietly, pauses
 * the audio, removes the cursor, and revokes every object URL it created.
 */

/** ~150 spoken words per minute; floor so one-word chunks still get a dwell. */
const MS_PER_WORD = 400;
const MIN_CHUNK_MS = 1200;

export const estimateSpeechMs = (text: string) =>
  Math.max(MIN_CHUNK_MS, text.trim().split(/\s+/).length * MS_PER_WORD);

/** POST narration text to the backend TTS proxy; resolves to mp3 bytes. */
const fetchSpeech = async (
  text: string,
  signal: AbortSignal,
): Promise<Blob> => {
  const response = await fetch(`${API_BASE}/api/tutor/speech`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
    signal,
  });

  if (!response.ok) {
    let message: string | undefined;
    try {
      message = (await response.json())?.error;
    } catch {
      // non-JSON error body — fall through to the status-based message
    }
    throw new Error(message || `Speech request failed (${response.status}).`);
  }

  return response.blob();
};

/**
 * Play one clip to the end. Resolves when the audio finishes OR the signal
 * aborts (pausing the audio); rejects only on a genuine playback failure.
 */
const playClip = (audio: HTMLAudioElement, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const cleanup = () => {
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onEnded = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Audio playback failed in this browser."));
    };
    const onAbort = () => {
      audio.pause();
      cleanup();
      resolve();
    };

    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onError);
    signal.addEventListener("abort", onAbort);

    audio.play().catch((error) => {
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });

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

/** How long to wait for audio metadata before falling back to an estimate. */
const METADATA_TIMEOUT_MS = 1500;

/**
 * The clip's real length in ms, or a words-per-minute estimate if metadata
 * does not arrive promptly (jsdom never fires `loadedmetadata`).
 */
const resolveClipDuration = (audio: HTMLAudioElement, narration: string) =>
  new Promise<number>((resolve) => {
    const fallback = estimateSpeechMs(narration);

    const settle = (value: number) => {
      clearTimeout(timer);
      audio.removeEventListener("loadedmetadata", onLoaded);
      resolve(value);
    };
    const onLoaded = () =>
      settle(
        Number.isFinite(audio.duration) && audio.duration > 0
          ? audio.duration * 1000
          : fallback,
      );
    const timer = setTimeout(() => settle(fallback), METADATA_TIMEOUT_MS);

    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      settle(audio.duration * 1000);
      return;
    }
    audio.addEventListener("loadedmetadata", onLoaded);
  });

type LessonChunk = { elementIds: string[]; narration: string };

/** Flatten a lesson into narration chunks; intro/closing point at nothing. */
const toChunks = (lesson: TutorLesson): LessonChunk[] =>
  [
    { elementIds: [], narration: lesson.intro },
    ...lesson.segments,
    { elementIds: [], narration: lesson.closing },
  ].filter((chunk) => chunk.narration.trim().length > 0);

/**
 * Speak one chunk while tracing its elements. Returns when the audio ends,
 * along with where the cursor came to rest so the next chunk glides on from
 * there.
 */
const playChunk = async (
  api: ExcalidrawImperativeAPI,
  chunk: LessonChunk,
  audio: HTMLAudioElement,
  cursorEnabled: boolean,
  signal: AbortSignal,
  cursorFrom: CursorPoint | null,
): Promise<CursorPoint | null> => {
  // Re-read the scene per chunk: the user may move things mid-lesson, and the
  // cursor should point where the element is NOW.
  const anchors = cursorEnabled
    ? segmentAnchors(get_scene(api), chunk.elementIds)
    : [];

  if (anchors.length > 0) {
    focusViewport(api, chunk.elementIds);
    // Place the cursor before the glide starts: on the very first chunk with
    // elements there is nowhere to glide from, and an unplaced cursor would
    // pop in mid-sentence.
    showTutorCursor(api, cursorFrom ?? anchors[0]);
  }

  // Duration is only known once metadata loads, so wait briefly for it — a
  // freshly constructed Audio always reports NaN. jsdom never fires the event,
  // and a slow decode should not stall the lesson, hence the short race with a
  // words-per-minute estimate as the fallback pace.
  const traceMs = await resolveClipDuration(audio, chunk.narration);

  // The trace gets its own signal so it stops the moment the audio ends,
  // instead of dwelling out its estimated time.
  const traceController = new AbortController();
  const forwardAbort = () => traceController.abort();
  signal.addEventListener("abort", forwardAbort);

  try {
    const trace =
      anchors.length > 0
        ? tracePointer(
            api,
            anchors,
            traceMs,
            traceController.signal,
            cursorFrom,
          )
        : Promise.resolve(cursorFrom);
    await playClip(audio, signal);
    traceController.abort();
    return await trace;
  } finally {
    signal.removeEventListener("abort", forwardAbort);
  }
};

export const playLesson = async (
  api: ExcalidrawImperativeAPI,
  lesson: TutorLesson,
  { signal, onNarration }: TutorPlaybackCallbacks & { signal: AbortSignal },
) => {
  const chunks = toChunks(lesson);
  if (chunks.length === 0) {
    return;
  }

  // A live collab session owns the collaborators map — never fight it for the
  // cursor. The lesson still plays, just without the pointer. Sampled once at
  // lesson start: a session joined mid-lesson is not detected until the next.
  const cursorEnabled = (api.getAppState().collaborators?.size ?? 0) === 0;
  const objectUrls: string[] = [];

  // Where the cursor rests between chunks, threaded through playChunk so it
  // glides on rather than teleporting — and so it never leaks between lessons.
  let cursorAt: CursorPoint | null = null;

  try {
    // Every prefetch carries a stray-rejection guard: if the loop exits early
    // (abort) without awaiting one, its failure must not become an unhandled
    // rejection. The guard never swallows an error the loop still awaits —
    // `await` on an already-handled promise still sees the rejection.
    let upcoming: Promise<Blob> | null = fetchSpeech(chunks[0].narration, signal);
    upcoming.catch(() => {});

    for (let i = 0; i < chunks.length; i++) {
      if (signal.aborted) {
        return;
      }

      const blob = await upcoming!;
      // Prefetch the next chunk's audio while this one plays — this overlap is
      // what makes the narration gapless.
      upcoming =
        i + 1 < chunks.length
          ? fetchSpeech(chunks[i + 1].narration, signal)
          : null;
      upcoming?.catch(() => {});

      if (signal.aborted) {
        return;
      }

      onNarration(chunks[i].narration);

      const url = URL.createObjectURL(blob);
      objectUrls.push(url);
      cursorAt = await playChunk(
        api,
        chunks[i],
        new Audio(url),
        cursorEnabled,
        signal,
        cursorAt,
      );
    }
  } finally {
    if (cursorEnabled) {
      hideTutorCursor(api);
    }
    for (const url of objectUrls) {
      URL.revokeObjectURL(url);
    }
  }
};
