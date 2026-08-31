import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { executeTool, get_scene } from "./toolLayer";
import { isTeaching, stopLesson } from "./tutorSession";

/**
 * Live voice agent transport for the browser.
 *
 * One WebSocket to our backend carries everything: microphone audio up, spoken
 * audio and tool calls down. The backend holds the Azure credential and owns the
 * session config, so this module never sees a key and cannot widen the tool set.
 *
 * Audio contract, fixed by the realtime API:
 *   - 24 kHz, mono, signed 16-bit PCM, little-endian, base64 on the wire
 *   - the browser resamples for us if we ask AudioContext for 24 kHz directly
 */
const SAMPLE_RATE = 24000;

/** Emitted upward so the sidebar can render conversation and status. */
export type VoiceEvents = {
  onStatus: (status: VoiceStatus) => void;
  onUserTranscript: (text: string) => void;
  onAgentTranscript: (text: string) => void;
  onToolRun: (text: string, failed: boolean) => void;
  onError: (message: string) => void;
};

export type VoiceStatus =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "speaking";

const encodeBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

const decodeBase64 = (value: string) => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
};

/**
 * Capture worklet, inlined as a blob so there is no separate asset to serve or
 * path to get wrong across dev and build. It only forwards frames; all encoding
 * happens on the main thread.
 */
const CAPTURE_WORKLET = `
class CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) {
      this.port.postMessage(new Float32Array(channel));
    }
    return true;
  }
}
registerProcessor("voice-capture", CaptureProcessor);
`;

const floatToPCM16 = (input: Float32Array) => {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const clamped = Math.max(-1, Math.min(1, input[i]));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return new Uint8Array(out.buffer);
};

export class VoiceAgent {
  private socket: WebSocket | null = null;

  private micStream: MediaStream | null = null;

  private captureContext: AudioContext | null = null;

  private playbackContext: AudioContext | null = null;

  /** Wall-clock cursor for gapless scheduling of streamed audio chunks. */
  private playheadAt = 0;

  private activeSources = new Set<AudioBufferSourceNode>();

  private closing = false;

  /**
   * A single realtime response can contain several tool calls — the model
   * called add_rectangle three times and bind_arrow four times within one
   * response while building a diagram, confirmed by instrumenting the live
   * socket. `response.create` must fire once per RESPONSE, not once per tool
   * call: sending it immediately after every result races against the still-
   * open response and the API answers with `conversation_already_has_active_
   * response`. So a continuation is requested only after `response.done`,
   * and only if a tool actually ran during that response.
   */
  private responseOpen = false;

  private continuationPending = false;

  constructor(
    private readonly api: ExcalidrawImperativeAPI,
    private readonly baseUrl: string,
    private readonly events: VoiceEvents,
  ) {}

  async start() {
    if (this.socket) {
      return;
    }
    this.closing = false;
    this.events.onStatus("connecting");

    // The tutor narrates through a separate pipeline; two voices at once is
    // never what anyone wants.
    if (isTeaching()) {
      stopLesson();
    }

    try {
      this.micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch {
      this.events.onError(
        "Microphone access was denied. Allow it in the browser to talk to the agent.",
      );
      this.events.onStatus("idle");
      return;
    }

    const url = `${this.baseUrl.replace(/^http/, "ws")}/api/realtime`;
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.onopen = () => {
      // Hand the agent the canvas as it stands, so its first sentence can be
      // about the actual diagram rather than a question about what is on screen.
      this.send({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: `[canvas state, not spoken by the user] ${JSON.stringify(
                get_scene(this.api),
              )}`,
            },
          ],
        },
      });
      void this.startCapture();
      this.events.onStatus("listening");
    };

    socket.onmessage = (event) => this.handleEvent(JSON.parse(event.data));

    socket.onerror = () => {
      if (!this.closing) {
        this.events.onError(
          `Could not reach the voice backend at ${this.baseUrl}. Is the server running?`,
        );
      }
    };

    socket.onclose = () => {
      if (!this.closing) {
        this.stop();
      }
    };
  }

  stop() {
    this.closing = true;

    this.stopPlayback();

    this.captureContext?.close().catch(() => {});
    this.captureContext = null;

    this.playbackContext?.close().catch(() => {});
    this.playbackContext = null;

    this.micStream?.getTracks().forEach((track) => track.stop());
    this.micStream = null;

    this.socket?.close();
    this.socket = null;

    this.events.onStatus("idle");
  }

  private send(payload: unknown) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  private async startCapture() {
    // Asking for 24 kHz directly lets the browser resample the mic for us.
    const context = new AudioContext({ sampleRate: SAMPLE_RATE });
    this.captureContext = context;

    const blob = new Blob([CAPTURE_WORKLET], {
      type: "application/javascript",
    });
    const moduleUrl = URL.createObjectURL(blob);
    try {
      await context.audioWorklet.addModule(moduleUrl);
    } finally {
      URL.revokeObjectURL(moduleUrl);
    }

    const source = context.createMediaStreamSource(this.micStream!);
    const capture = new AudioWorkletNode(context, "voice-capture");

    capture.port.onmessage = (event) => {
      this.send({
        type: "input_audio_buffer.append",
        audio: encodeBase64(floatToPCM16(event.data as Float32Array)),
      });
    };

    source.connect(capture);
    // Route to a muted gain rather than the speakers, or the user hears
    // themselves. Some browsers stall a worklet with no downstream node at all.
    const silence = context.createGain();
    silence.gain.value = 0;
    capture.connect(silence).connect(context.destination);
  }

  private ensurePlayback() {
    if (!this.playbackContext) {
      this.playbackContext = new AudioContext({ sampleRate: SAMPLE_RATE });
      this.playheadAt = this.playbackContext.currentTime;
    }
    return this.playbackContext;
  }

  private stopPlayback() {
    for (const source of this.activeSources) {
      try {
        source.stop();
      } catch {
        // already finished
      }
    }
    this.activeSources.clear();
    if (this.playbackContext) {
      this.playheadAt = this.playbackContext.currentTime;
    }
  }

  private enqueueAudio(base64: string) {
    const context = this.ensurePlayback();
    const bytes = decodeBase64(base64);
    const samples = new Int16Array(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength / 2,
    );

    const buffer = context.createBuffer(1, samples.length, SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) {
      channel[i] = samples[i] / 0x8000;
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);

    // Never schedule in the past, or chunks pile up and play over each other.
    this.playheadAt = Math.max(this.playheadAt, context.currentTime);
    source.start(this.playheadAt);
    this.playheadAt += buffer.duration;

    this.activeSources.add(source);
    source.onended = () => this.activeSources.delete(source);
  }

  private handleEvent(message: any) {
    switch (message.type) {
      case "input_audio_buffer.speech_started":
        // Barge-in: the server cancels its response, we drop what is already
        // queued locally so the agent goes quiet immediately rather than
        // finishing the sentence it had buffered.
        this.stopPlayback();
        this.events.onStatus("listening");
        break;

      case "response.audio.delta":
        this.events.onStatus("speaking");
        this.enqueueAudio(message.delta);
        break;

      case "response.created":
        this.responseOpen = true;
        this.events.onStatus("thinking");
        break;

      case "conversation.item.input_audio_transcription.completed":
        if (message.transcript?.trim()) {
          this.events.onUserTranscript(message.transcript.trim());
        }
        break;

      case "response.audio_transcript.done":
        if (message.transcript?.trim()) {
          this.events.onAgentTranscript(message.transcript.trim());
        }
        break;

      case "response.function_call_arguments.done":
        this.runTool(message);
        break;

      case "response.done":
        this.responseOpen = false;
        if (this.continuationPending) {
          this.continuationPending = false;
          this.send({ type: "response.create" });
        }
        this.events.onStatus("listening");
        break;

      // Not a realtime protocol event — the server emits this when it
      // intercepts a `think` call, so the sidebar can show the pause for what
      // it is rather than leaving a silent gap in the transcript.
      case "app.thinking": {
        const question = String(message.question ?? "");
        this.events.onToolRun(
          question
            ? `thinking it through: “${
                question.length > 90 ? `${question.slice(0, 90)}…` : question
              }”`
            : "thinking it through…",
          false,
        );
        this.events.onStatus("thinking");
        break;
      }

      case "error":
        this.events.onError(
          message.error?.message ?? "The voice session hit an error.",
        );
        break;

      default:
        break;
    }
  }

  private runTool(message: {
    call_id: string;
    name: string;
    arguments: string;
  }) {
    let input: unknown = {};
    try {
      input = message.arguments ? JSON.parse(message.arguments) : {};
    } catch {
      input = {};
    }

    const outcome = executeTool(this.api, message.name, input);

    this.events.onToolRun(
      outcome.ok
        ? describeVoiceCall(message.name, input)
        : `${message.name} failed: ${outcome.error}`,
      !outcome.ok,
    );

    this.send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: message.call_id,
        output: outcome.ok
          ? JSON.stringify(outcome.result)
          : `Error: ${outcome.error}`,
      },
    });
    // The model does not continue on its own after a tool result, but
    // requesting the continuation now would race a still-open response if
    // this was one of several tool calls in it. Fire immediately only when
    // nothing is in flight; otherwise defer to response.done.
    if (this.responseOpen) {
      this.continuationPending = true;
    } else {
      this.send({ type: "response.create" });
    }
  }
}

const describeVoiceCall = (name: string, input: any) => {
  switch (name) {
    case "get_scene":
      return "read the canvas";
    case "add_rectangle":
      return `added “${input.label}”`;
    case "add_text":
      return `added text “${input.text}”`;
    case "bind_arrow":
      return "connected two elements";
    case "set_style":
      return `restyled ${input.ids?.length ?? 0} element(s)`;
    case "remove_element":
      return "removed an element";
    default:
      return name;
  }
};
