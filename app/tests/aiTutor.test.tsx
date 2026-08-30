import { resolvablePromise } from "@excalidraw/common";
import { Excalidraw } from "@excalidraw/excalidraw";
import { render } from "@excalidraw/excalidraw/tests/test-utils";
import { fireEvent } from "@testing-library/react";
import { vi } from "vitest";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { TutorControls } from "../ai-agent/TutorControls";
import { TUTOR_SOCKET_ID, segmentAnchors } from "../ai-agent/tutorCursor";
import { playLesson } from "../ai-agent/tutorPlayer";
import { isTeaching, stopLesson } from "../ai-agent/tutorSession";
import {
  TOOL_IMPLEMENTATIONS,
  add_rectangle,
  executeTool,
  get_scene,
} from "../ai-agent/toolLayer";

import type { TutorLesson } from "../ai-agent/types/tutor";

/** Poll until a condition holds — jsdom audio/fetch stubs resolve async. */
const until = async (cond: () => boolean) => {
  for (let i = 0; i < 400 && !cond(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(cond()).toBe(true);
};

/**
 * jsdom does not implement the Web Speech API, so we install a fake
 * `speechSynthesis`. Each `speak()` parks a resolver instead of speaking, so a
 * test decides exactly when an utterance "finishes" — which is what lets us
 * assert on state *during* narration.
 */
const pendingClips: Array<() => void> = [];
let spoken: string[] = [];

const finishClip = async () => {
  await until(() => pendingClips.length > 0);
  pendingClips.shift()!();
};

class FakeUtterance {
  text: string;
  voice: unknown = null;
  rate = 1;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;

  constructor(text: string) {
    this.text = text;
  }
}

const installSpeechStub = () => {
  spoken = [];
  const speech = {
    speaking: true,
    speak: (utterance: FakeUtterance) => {
      spoken.push(utterance.text);
      pendingClips.push(() => utterance.onend?.());
    },
    // cancel() detaches nothing itself — tutorSpeech clears its own handlers
    // before calling it, mirroring the real "interrupted" behaviour.
    cancel: () => {
      pendingClips.length = 0;
    },
    resume: () => {},
    pause: () => {},
    getVoices: () => [],
  };
  (window as any).speechSynthesis = speech;
  (globalThis as any).SpeechSynthesisUtterance = FakeUtterance;
};

let fetchSpy: ReturnType<typeof vi.spyOn>;

const CANNED_LESSON = {
  intro: "Here is your diagram.",
  segments: [{ elementIds: ["placeholder"], narration: "A box." }],
  closing: "Done.",
};

const stubNetwork = () => {
  fetchSpy = vi
    .spyOn(globalThis, "fetch" as any)
    .mockImplementation(async (url: any) => {
      const target = String(url);
      if (target.endsWith("/api/tutor/lesson")) {
        return {
          ok: true,
          json: async () => ({ lesson: CANNED_LESSON }),
        } as Response;
      }
      throw new Error(`Unexpected fetch in test: ${target}`);
    });
};

beforeEach(() => {
  pendingClips.length = 0;
  stubNetwork();
  installSpeechStub();
});

afterEach(async () => {
  // The session is a module singleton, so a lesson left running would leak
  // into the next test. Stop it and let the real cleanup path settle.
  stopLesson();
  await until(() => !isTeaching());
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

describe("teach_diagram as a WebMCP tool", () => {
  let api: ExcalidrawImperativeAPI;

  beforeEach(async () => {
    api = await mountEditor();
  });

  it("is registered in the tool layer alongside the drawing tools", () => {
    expect(Object.keys(TOOL_IMPLEMENTATIONS)).toContain("teach_diagram");
  });

  it("starts a lesson and returns immediately, without waiting for narration", () => {
    add_rectangle(api, {
      x: 100,
      y: 100,
      width: 180,
      height: 80,
      label: "Database",
    });

    const outcome = executeTool(api, "teach_diagram", {});

    // The agent loop is synchronous; a minute of audio must not block it.
    expect(outcome).toMatchObject({
      ok: true,
      result: { started: true, elements: 1 },
    });
    expect(isTeaching()).toBe(true);
  });

  it("reports an empty canvas as a tool error the model can recover from", () => {
    const outcome = executeTool(api, "teach_diagram", {});

    expect(outcome.ok).toBe(false);
    expect((outcome as { error: string }).error).toMatch(/empty/i);
    expect(isTeaching()).toBe(false);
  });

  it("refuses to start a second lesson on top of a running one", () => {
    add_rectangle(api, { x: 0, y: 0, width: 180, height: 80, label: "A" });

    expect(executeTool(api, "teach_diagram", {}).ok).toBe(true);
    const second = executeTool(api, "teach_diagram", {});

    expect(second.ok).toBe(false);
    expect((second as { error: string }).error).toMatch(/already/i);
  });

  it("shares one session with the Teach button — stopLesson ends a tool-started lesson", async () => {
    add_rectangle(api, { x: 0, y: 0, width: 180, height: 80, label: "A" });
    executeTool(api, "teach_diagram", {});
    expect(isTeaching()).toBe(true);

    stopLesson();
    await until(() => !isTeaching());
  });
});

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
      readScene: () => get_scene(api),
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
      readScene: () => get_scene(api),
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
      readScene: () => get_scene(api),
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
      readScene: () => get_scene(api),
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

  it("surfaces a synthesis failure as a readable error, and still cleans up", async () => {
    (window as any).speechSynthesis.speak = (utterance: FakeUtterance) => {
      pendingClips.push(() =>
        utterance.onerror?.({ error: "synthesis-failed" }),
      );
    };

    const playing = playLesson(api, lesson, {
      signal: new AbortController().signal,
      readScene: () => get_scene(api),
      onNarration: () => {},
    });
    await finishClip();

    await expect(playing).rejects.toThrow(/synthesis-failed/);
    // hide goes through React setState, which flushes async - poll, don't read.
    await until(() => !tutorCollaborator(api));
  });

  it("treats an interrupted utterance as a stop, not a failure", async () => {
    (window as any).speechSynthesis.speak = (utterance: FakeUtterance) => {
      pendingClips.push(() => utterance.onerror?.({ error: "interrupted" }));
    };

    const playing = playLesson(api, lesson, {
      signal: new AbortController().signal,
      readScene: () => get_scene(api),
      onNarration: () => {},
    });
    for (let i = 0; i < 3; i++) {
      await finishClip();
    }

    await expect(playing).resolves.toBeUndefined();
  });
});

describe("TutorControls", () => {
  const entries: string[] = [];
  const recorded: string[] = [];

  const mountControls = async () => {
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
    const container = await mountControls();
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

  it("renders a Teach button when the browser can speak", async () => {
    const container = await mountControls();
    await until(() =>
      Boolean(container.querySelector("button.ai-tutor__teach")),
    );
  });

  it("renders nothing in a browser without speech synthesis", async () => {
    delete (window as any).speechSynthesis;
    const container = await mountControls();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(container.querySelector("button.ai-tutor__teach")).toBeNull();
  });
});
