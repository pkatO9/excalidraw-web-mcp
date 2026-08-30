import { resolvablePromise } from "@excalidraw/common";
import { Excalidraw } from "@excalidraw/excalidraw";
import { render } from "@excalidraw/excalidraw/tests/test-utils";
import { fireEvent } from "@testing-library/react";
import { vi } from "vitest";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { TutorControls } from "../ai-agent/TutorControls";
import { TUTOR_SOCKET_ID, segmentAnchors } from "../ai-agent/tutorCursor";
import { playLesson } from "../ai-agent/tutorPlayer";
import { add_rectangle, get_scene } from "../ai-agent/toolLayer";

import type { TutorLesson } from "../ai-agent/types/tutor";

/** Poll until a condition holds — jsdom audio/fetch stubs resolve async. */
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(cond()).toBe(true);
};

/**
 * jsdom implements neither audio playback nor object URLs. `play` is stubbed to
 * queue a manual trigger, so each test decides exactly when a clip "finishes" —
 * that is what lets us assert on the state *during* playback.
 */
const pendingClips: Array<() => void> = [];

const finishClip = async () => {
  await until(() => pendingClips.length > 0);
  pendingClips.shift()!();
};

let fetchSpy: ReturnType<typeof vi.spyOn>;

const stubNetwork = (health: { tts: boolean }) => {
  fetchSpy = vi
    .spyOn(globalThis, "fetch" as any)
    .mockImplementation(async (url: any) => {
      const target = String(url);
      if (target.endsWith("/api/health")) {
        return {
          ok: true,
          json: async () => ({ ok: true, tts: health.tts }),
        } as Response;
      }
      if (target.endsWith("/api/tutor/speech")) {
        return {
          ok: true,
          blob: async () => new Blob(["audio"], { type: "audio/mpeg" }),
        } as Response;
      }
      throw new Error(`Unexpected fetch in test: ${target}`);
    });
};

beforeEach(() => {
  pendingClips.length = 0;
  stubNetwork({ tts: true });

  // jsdom never loads metadata, so duration stays NaN and the player would
  // wait out its metadata timeout on every chunk. Report a real duration and
  // fire the event, which both keeps the suite fast and exercises the
  // real-duration pacing path rather than the estimate fallback.
  vi.spyOn(HTMLMediaElement.prototype, "duration", "get").mockReturnValue(0.05);

  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    this.dispatchEvent(new Event("loadedmetadata"));
    pendingClips.push(() => this.dispatchEvent(new Event("ended")));
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});

  (URL as any).createObjectURL = vi.fn(() => "blob:tutor-test");
  (URL as any).revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const mountEditor = async () => {
  const apiPromise = resolvablePromise<ExcalidrawImperativeAPI>();
  await render(
    <Excalidraw onExcalidrawAPI={(a) => apiPromise.resolve(a as any)} />,
  );
  return apiPromise;
};

const tutorCollaborator = (api: ExcalidrawImperativeAPI) =>
  api.getAppState().collaborators?.get(TUTOR_SOCKET_ID as any);

describe("segmentAnchors", () => {
  it("anchors above the top-centre of each referenced element, in order", () => {
    const scene = [
      { id: "a", type: "rectangle", x: 100, y: 200, width: 180, height: 80 },
      { id: "b", type: "rectangle", x: 400, y: 200, width: 100, height: 50 },
    ] as any;

    const anchors = segmentAnchors(scene, ["b", "a"]);
    expect(anchors).toHaveLength(2);
    expect(anchors[0].x).toBe(450); // b centre
    expect(anchors[0].y).toBeLessThanOrEqual(200); // at or above b's top edge
    expect(anchors[1].x).toBe(190); // a centre
  });

  it("ignores ids that are not in the scene", () => {
    const scene = [
      { id: "a", type: "rectangle", x: 0, y: 0, width: 10, height: 10 },
    ] as any;
    expect(segmentAnchors(scene, ["ghost"])).toHaveLength(0);
    expect(segmentAnchors(scene, ["ghost", "a"])).toHaveLength(1);
  });
});

describe("playLesson", () => {
  let api: ExcalidrawImperativeAPI;
  let lesson: TutorLesson;

  beforeEach(async () => {
    api = await mountEditor();
    const box = add_rectangle(api, {
      x: 100,
      y: 100,
      width: 180,
      height: 80,
      label: "Database",
    });
    lesson = {
      intro: "Here is your diagram.",
      segments: [{ elementIds: [box.id], narration: "This is the database." }],
      closing: "And that is everything.",
    };
  });

  it("narrates intro, segments, then closing, in order", async () => {
    const narrated: string[] = [];
    const done = playLesson(api, lesson, {
      signal: new AbortController().signal,
      onNarration: (text) => narrated.push(text),
    });

    await finishClip(); // intro
    await finishClip(); // segment
    await finishClip(); // closing
    await done;

    expect(narrated).toEqual([
      "Here is your diagram.",
      "This is the database.",
      "And that is everything.",
    ]);
  });

  it("shows the Tutor cursor while a segment plays and removes it after", async () => {
    const done = playLesson(api, lesson, {
      signal: new AbortController().signal,
      onNarration: () => {},
    });

    await finishClip(); // intro (no elements — cursor may not be placed yet)
    // Segment clip is now queued: the cursor must be on the canvas.
    await until(() => Boolean(tutorCollaborator(api)));

    await finishClip(); // segment
    await finishClip(); // closing
    await done;

    // hide goes through React setState, which flushes async - poll, don't read.
    await until(() => !tutorCollaborator(api));
  });

  it("stops early and cleans up when aborted mid-lesson", async () => {
    const narrated: string[] = [];
    const controller = new AbortController();
    const done = playLesson(api, lesson, {
      signal: controller.signal,
      onNarration: (text) => narrated.push(text),
    });

    await finishClip(); // intro done, segment starts
    await until(() => narrated.length === 2);
    controller.abort();
    await done; // resolves quietly — stopping is a user action, not an error

    expect(narrated).toHaveLength(2); // closing never spoken
    // hide goes through React setState, which flushes async - poll, don't read.
    await until(() => !tutorCollaborator(api));
  });

  it("still narrates a segment whose element ids are unknown, without crashing", async () => {
    const narrated: string[] = [];
    const broken: TutorLesson = {
      ...lesson,
      segments: [{ elementIds: ["ghost"], narration: "A mystery box." }],
    };
    const done = playLesson(api, broken, {
      signal: new AbortController().signal,
      onNarration: (text) => narrated.push(text),
    });

    await finishClip();
    await finishClip();
    await finishClip();
    await done;

    expect(narrated).toContain("A mystery box.");
    // hide goes through React setState, which flushes async - poll, don't read.
    await until(() => !tutorCollaborator(api));
  });

  it("surfaces a speech-endpoint failure as a readable error", async () => {
    fetchSpy.mockImplementation(async () => {
      return {
        ok: false,
        status: 503,
        json: async () => ({ error: "TTS is not configured." }),
      } as Response;
    });

    await expect(
      playLesson(api, lesson, {
        signal: new AbortController().signal,
        onNarration: () => {},
      }),
    ).rejects.toThrow(/TTS is not configured/);
    // hide goes through React setState, which flushes async - poll, don't read.
    await until(() => !tutorCollaborator(api));
  });
});

describe("TutorControls", () => {
  const entries: string[] = [];
  const recorded: string[] = [];

  const mountControls = async (health: { tts: boolean }) => {
    stubNetwork(health);
    entries.length = 0;
    recorded.length = 0;
    const apiPromise = resolvablePromise<ExcalidrawImperativeAPI>();
    const { container } = await render(
      <Excalidraw onExcalidrawAPI={(a) => apiPromise.resolve(a as any)}>
        <TutorControls
          onEntry={(entry) => entries.push(entry.text)}
          onAssistantMessage={(text) => recorded.push(text)}
        />
      </Excalidraw>,
    );
    await apiPromise;
    return container;
  };

  it("refuses to teach an empty canvas without calling the backend", async () => {
    const container = await mountControls({ tts: true });
    await until(() =>
      Boolean(container.querySelector("button.ai-tutor__teach")),
    );
    const lessonCalls = () =>
      fetchSpy.mock.calls.filter((call: any) =>
        String(call[0]).endsWith("/api/tutor/lesson"),
      ).length;

    fireEvent.click(container.querySelector("button.ai-tutor__teach")!);
    await until(() => entries.some((text) => /canvas is empty/i.test(text)));
    expect(lessonCalls()).toBe(0);
    expect(recorded).toHaveLength(0);
  });

  it("renders a Teach button when the backend reports TTS support", async () => {
    const container = await mountControls({ tts: true });
    await until(() =>
      Boolean(container.querySelector("button.ai-tutor__teach")),
    );
  });

  it("renders nothing when the backend has no TTS configured", async () => {
    const container = await mountControls({ tts: false });
    // Give the health check time to land, then confirm the button never showed.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container.querySelector("button.ai-tutor__teach")).toBeNull();
  });
});
