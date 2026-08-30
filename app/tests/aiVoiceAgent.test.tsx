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

  it("reports a failed tool back to the model instead of throwing", async () => {
    const { socket } = await startAgent();
    socket.sent.length = 0;

    socket.emit({
      type: "response.function_call_arguments.done",
      call_id: "call_2",
      name: "remove_element",
      arguments: JSON.stringify({ id: "does-not-exist" }),
    });

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

  it("surfaces a server error to the caller", async () => {
    const { socket } = await startAgent();
    socket.emit({ type: "error", error: { message: "quota exceeded" } });
    expect(events.onError).toHaveBeenCalledWith("quota exceeded");
  });
});
