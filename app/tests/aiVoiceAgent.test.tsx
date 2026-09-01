import { resolvablePromise } from "@excalidraw/common";
import { Excalidraw } from "@excalidraw/excalidraw";
import { render } from "@excalidraw/excalidraw/tests/test-utils";
import { vi } from "vitest";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { add_rectangle, get_scene } from "../ai-agent/toolLayer";
import { VoiceAgent } from "../ai-agent/voiceAgent";

/**
 * Audio is stubbed; the tool round trip is not. What matters here is that a
 * function call off the socket really mutates the canvas and that a correctly
 * shaped result goes back, since that is the whole contract between the voice
 * session and the tool layer.
 */
class FakeSocket {
  static last: FakeSocket | null = null;

  static readonly OPEN = 1;

  readyState = 1;

  sent: any[] = [];

  onopen: (() => void) | null = null;

  onmessage: ((e: { data: string }) => void) | null = null;

  onerror: (() => void) | null = null;

  onclose: (() => void) | null = null;

  constructor() {
    FakeSocket.last = this;
  }

  send(payload: string) {
    this.sent.push(JSON.parse(payload));
  }

  close() {
    this.readyState = 3;
  }

  /** Simulate a server event arriving. */
  emit(message: unknown) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  sentOfType(type: string) {
    return this.sent.filter((m) => m.type === type);
  }
}

const stubAudio = () => {
  const gain = {
    gain: { value: 1 },
    connect: vi.fn(() => ({ connect: vi.fn() })),
  };
  (globalThis as any).AudioContext = class {
    currentTime = 0;

    destination = {};

    audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };

    createMediaStreamSource = vi.fn(() => ({ connect: vi.fn() }));

    createGain = vi.fn(() => gain);

    createBuffer = vi.fn((_c: number, length: number) => ({
      duration: length / 24000,
      getChannelData: () => new Float32Array(length),
    }));

    createBufferSource = vi.fn(() => ({
      buffer: null,
      connect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null,
    }));

    close = vi.fn().mockResolvedValue(undefined);
  };
  (globalThis as any).AudioWorkletNode = class {
    port = { onmessage: null };

    connect = vi.fn(() => ({ connect: vi.fn() }));
  };
  (globalThis as any).WebSocket = FakeSocket;
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [] }),
    },
  });
  (globalThis as any).URL.createObjectURL = vi.fn(() => "blob:stub");
  (globalThis as any).URL.revokeObjectURL = vi.fn();
};

/**
 * Tools now run through the WebMCP surface, so they are async and queued.
 * Tests have to let the queue drain before asserting on what went back over
 * the socket.
 */
const flushTools = async () => {
  for (let i = 0; i < 6; i++) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("VoiceAgent", () => {
  let api: ExcalidrawImperativeAPI;
  let events: any;

  beforeEach(async () => {
    stubAudio();
    const p = resolvablePromise<ExcalidrawImperativeAPI>();
    await render(<Excalidraw onExcalidrawAPI={(a) => p.resolve(a as any)} />);
    api = await p;
    events = {
      onStatus: vi.fn(),
      onUserTranscript: vi.fn(),
      onAgentTranscript: vi.fn(),
      onToolRun: vi.fn(),
      onError: vi.fn(),
    };
  });

  const startAgent = async () => {
    const agent = new VoiceAgent(api, "http://localhost:8787", events);
    await agent.start();
    const socket = FakeSocket.last!;
    socket.onopen?.();
    return { agent, socket };
  };

  it("connects over ws:// and opens with the current canvas as context", async () => {
    add_rectangle(api, {
      x: 0,
      y: 0,
      width: 180,
      height: 80,
      label: "API Server",
    });

    const { socket } = await startAgent();

    const opening = socket.sentOfType("conversation.item.create")[0];
    expect(opening.item.content[0].text).toContain("API Server");
    expect(events.onStatus).toHaveBeenCalledWith("listening");
  });

  it("runs a tool call against the real canvas and returns the result", async () => {
    const { socket } = await startAgent();
    socket.sent.length = 0;

    socket.emit({
      type: "response.function_call_arguments.done",
      call_id: "call_1",
      name: "add_rectangle",
      arguments: JSON.stringify({
        x: 200,
        y: 120,
        width: 180,
        height: 80,
        label: "Database",
      }),
    });
    await flushTools();

    // the canvas actually changed
    const scene = get_scene(api);
    expect(scene).toHaveLength(1);
    expect(scene[0]).toMatchObject({ label: "Database", x: 200, y: 120 });

    // and the result went back in the shape the API expects, followed by the
    // response.create that makes the model continue
    const output = socket.sentOfType("conversation.item.create")[0];
    expect(output.item.type).toBe("function_call_output");
    expect(output.item.call_id).toBe("call_1");
    expect(JSON.parse(output.item.output).label).toBe("Database");
    expect(socket.sentOfType("response.create")).toHaveLength(1);

    expect(events.onToolRun).toHaveBeenCalledWith(
      expect.stringContaining("Database"),
      false,
    );
  });

  it("coalesces several tool calls in one response into a single continuation", async () => {
    // Regression: instrumenting the live socket while drawing a 3-tier diagram
    // showed the model routinely batching several tool calls into ONE
    // response — 3 add_rectangle calls in one response, 4 bind_arrow calls in
    // another. Firing response.create after every individual result raced the
    // still-open response and the API answered with
    // "conversation_already_has_active_response". The fix defers the
    // continuation until response.done and coalesces it to one request.
    const { socket } = await startAgent();
    socket.sent.length = 0;

    socket.emit({ type: "response.created", response: { id: "resp_1" } });

    for (const label of ["A", "B", "C"]) {
      socket.emit({
        type: "response.function_call_arguments.done",
        response_id: "resp_1",
        call_id: `call_${label}`,
        name: "add_rectangle",
        arguments: JSON.stringify({
          x: 200,
          y: 120,
          width: 180,
          height: 80,
          label,
        }),
      });
    }
    await flushTools();

    // all three tool calls ran and their results went back
    expect(get_scene(api)).toHaveLength(3);
    const outputs = socket.sentOfType("conversation.item.create");
    expect(outputs).toHaveLength(3);
    expect(
      outputs.every((m: any) => m.item.type === "function_call_output"),
    ).toBe(true);

    // ...but the continuation has not been requested while the response is
    // still open, and definitely not three times
    expect(socket.sentOfType("response.create")).toHaveLength(0);

    socket.emit({ type: "response.done" });
    await flushTools();

    // exactly one continuation, sent only after the response actually closed
    expect(socket.sentOfType("response.create")).toHaveLength(1);
  });

  it("waits for an in-flight tool before continuing, even if the response closes first", async () => {
    // The hazard introduced by making tools async: response.done can now
    // arrive while a tool is still running. Firing the continuation on
    // response.done alone would send it before the result exists; skipping it
    // would strand the turn and the agent would fall silent.
    const { socket } = await startAgent();
    socket.sent.length = 0;

    socket.emit({ type: "response.created", response: { id: "resp_1" } });
    socket.emit({
      type: "response.function_call_arguments.done",
      response_id: "resp_1",
      call_id: "call_slow",
      name: "add_rectangle",
      arguments: JSON.stringify({
        x: 0,
        y: 0,
        width: 180,
        height: 80,
        label: "Slow",
      }),
    });

    // response closes before the tool has had a chance to resolve
    socket.emit({ type: "response.done" });
    await flushTools();

    // the result still went back, and exactly one continuation followed it
    const outputs = socket.sentOfType("conversation.item.create");
    expect(outputs).toHaveLength(1);
    expect(outputs[0].item.call_id).toBe("call_slow");
    expect(socket.sentOfType("response.create")).toHaveLength(1);
  });

  it("still continues immediately for a lone tool call outside any tracked response", async () => {
    // No response.created was emitted here (mirrors the pre-existing test
    // below) — responseOpen defaults to false, so nothing should be deferred.
    const { socket } = await startAgent();
    socket.sent.length = 0;

    socket.emit({
      type: "response.function_call_arguments.done",
      call_id: "call_solo",
      name: "add_text",
      arguments: JSON.stringify({ x: 0, y: 0, text: "hi" }),
    });
    await flushTools();

    expect(socket.sentOfType("response.create")).toHaveLength(1);
  });

  it("reports a failed tool back to the model instead of throwing", async () => {
    const { socket } = await startAgent();
    socket.sent.length = 0;

    socket.emit({
      type: "response.function_call_arguments.done",
      call_id: "call_2",
      name: "remove_element",
      arguments: JSON.stringify({ id: "does-not-exist" }),
    });
    await flushTools();

    const output = socket.sentOfType("conversation.item.create")[0];
    expect(output.item.output).toMatch(/^Error:/);
    expect(events.onToolRun).toHaveBeenCalledWith(
      expect.stringContaining("failed"),
      true,
    );
  });

  it("surfaces transcripts for both sides", async () => {
    const { socket } = await startAgent();

    socket.emit({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: "  add a cache next to the database  ",
    });
    socket.emit({
      type: "response.audio_transcript.done",
      transcript: "Done — cache is in.",
    });

    expect(events.onUserTranscript).toHaveBeenCalledWith(
      "add a cache next to the database",
    );
    expect(events.onAgentTranscript).toHaveBeenCalledWith(
      "Done — cache is in.",
    );
  });

  it("goes back to listening when the user talks over it", async () => {
    const { socket } = await startAgent();

    socket.emit({
      type: "response.audio.delta",
      delta: btoa("\x00\x00\x00\x00"),
    });
    expect(events.onStatus).toHaveBeenCalledWith("speaking");

    socket.emit({ type: "input_audio_buffer.speech_started" });
    expect(events.onStatus).toHaveBeenLastCalledWith("listening");
  });

  it("shows the thinking pause in the transcript without answering the call", async () => {
    // `think` is handled entirely server-side — it needs another model, not the
    // canvas. The server sends this custom event purely so the sidebar can show
    // the pause; the browser must NOT treat it as a tool call, or it would
    // answer a call_id the server has already answered.
    const { socket } = await startAgent();
    socket.sent.length = 0;

    socket.emit({
      type: "app.thinking",
      question: "Should this use a queue or a direct write path?",
    });

    expect(events.onToolRun).toHaveBeenCalledWith(
      expect.stringContaining("thinking it through"),
      false,
    );
    expect(events.onStatus).toHaveBeenLastCalledWith("thinking");

    // nothing went back over the socket — no output, no continuation
    expect(socket.sent).toHaveLength(0);
  });

  it("truncates a long thinking question in the transcript", async () => {
    const { socket } = await startAgent();
    socket.emit({ type: "app.thinking", question: "x".repeat(200) });

    const [[text]] = events.onToolRun.mock.calls.slice(-1);
    expect(text.length).toBeLessThan(140);
    expect(text).toContain("…");
  });

  it("hangs up after a minute of silence so an idle session stops billing", async () => {
    vi.useFakeTimers();
    try {
      const { socket } = await startAgent();
      expect(socket.readyState).toBe(1);

      // just under the limit, still live
      vi.advanceTimersByTime(59_000);
      expect(events.onStatus).not.toHaveBeenCalledWith("idle");

      vi.advanceTimersByTime(2_000);

      expect(events.onError).toHaveBeenCalledWith(
        expect.stringContaining("minute of silence"),
      );
      expect(events.onStatus).toHaveBeenLastCalledWith("idle");
    } finally {
      vi.useRealTimers();
    }
  });

  it("speaking resets the silence countdown", async () => {
    vi.useFakeTimers();
    try {
      const { socket } = await startAgent();

      vi.advanceTimersByTime(50_000);
      socket.emit({ type: "input_audio_buffer.speech_started" });
      vi.advanceTimersByTime(50_000); // 100s total, but only 50s since speech

      expect(events.onError).not.toHaveBeenCalledWith(
        expect.stringContaining("minute of silence"),
      );

      vi.advanceTimersByTime(15_000);
      expect(events.onError).toHaveBeenCalledWith(
        expect.stringContaining("minute of silence"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces a server error to the caller", async () => {
    const { socket } = await startAgent();
    socket.emit({ type: "error", error: { message: "quota exceeded" } });
    expect(events.onError).toHaveBeenCalledWith("quota exceeded");
  });
});
