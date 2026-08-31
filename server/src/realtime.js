import { WebSocketServer, WebSocket } from "ws";

import { TOOL_SCHEMAS } from "./toolSchemas.js";
import { runThink, THINK_TOOL, thinkDeployment } from "./thinkTool.js";
import { toRealtimeTools, VOICE_SYSTEM_PROMPT } from "./voicePrompt.js";

const API_VERSION =
  process.env.AZURE_OPENAI_REALTIME_API_VERSION || "2025-04-01-preview";
const DEPLOYMENT =
  process.env.AZURE_OPENAI_REALTIME_DEPLOYMENT || "gpt-realtime-2";
const VOICE = process.env.AZURE_OPENAI_REALTIME_VOICE || "alloy";

/**
 * Live voice agent transport.
 *
 * The browser talks to us; we talk to Azure. It would be fewer moving parts to
 * let the browser open the upstream socket directly, but that means shipping a
 * credential to the client — either the API key or a short-lived token minted
 * for it. Proxying keeps the key strictly server-side, and it also makes the
 * server the only place the session is configured: the browser cannot swap the
 * instructions or widen the tool list, it can only speak and listen.
 *
 * Audio and tool calls share this one socket, so there is no separate STT or TTS
 * hop to synchronise — the model hears speech and answers with speech and
 * function calls in the same stream.
 */
export const attachRealtime = (httpServer) => {
  const wss = new WebSocketServer({ server: httpServer, path: "/api/realtime" });

  wss.on("connection", (client) => {
    const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const apiKey = process.env.AZURE_OPENAI_API_KEY;

    if (!endpoint || !apiKey) {
      client.send(
        JSON.stringify({
          type: "error",
          error: {
            message:
              "Voice is unavailable: AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_API_KEY are not set on the server.",
          },
        }),
      );
      client.close();
      return;
    }

    const url = `${endpoint
      .replace(/^https:/, "wss:")
      .replace(/\/$/, "")}/openai/realtime?api-version=${API_VERSION}&deployment=${DEPLOYMENT}`;

    const upstream = new WebSocket(url, { headers: { "api-key": apiKey } });

    // Anything the browser says before the upstream is ready would be dropped,
    // so hold it rather than losing the opening moments of speech.
    const pending = [];
    let upstreamReady = false;

    upstream.on("open", () => {
      upstreamReady = true;

      upstream.send(
        JSON.stringify({
          type: "session.update",
          session: {
            modalities: ["audio", "text"],
            instructions: VOICE_SYSTEM_PROMPT,
            voice: VOICE,
            input_audio_format: "pcm16",
            output_audio_format: "pcm16",
            // Whisper gives us the user's words for the on-screen transcript;
            // the model itself hears the audio directly either way.
            input_audio_transcription: { model: "whisper-1" },
            // Server-side VAD makes it hands-free and, with interrupt_response,
            // lets the user talk over the agent to cut it off — which is most of
            // what makes a spoken agent feel live rather than turn-based.
            turn_detection: {
              type: "server_vad",
              threshold: 0.5,
              prefix_padding_ms: 300,
              silence_duration_ms: 500,
              create_response: true,
              interrupt_response: true,
            },
            // The tutor is deliberately withheld from the voice agent. Both
            // speak, through different pipelines (the tutor fetches mp3 and
            // plays it, this session streams its own PCM), so letting the agent
            // start a lesson would put two voices on the canvas at once. A live
            // agent explaining the diagram conversationally is the better answer
            // here anyway — that is the whole point of talking to it.
            tools: [
              ...toRealtimeTools(
                TOOL_SCHEMAS.filter((tool) => tool.name !== "teach_diagram"),
              ),
              // Handled here rather than in the browser: it needs no canvas
              // access, only another model, so round-tripping it to the client
              // would add a hop for nothing.
              THINK_TOOL,
            ],
            tool_choice: "auto",
          },
        }),
      );

      for (const message of pending.splice(0)) {
        upstream.send(message);
      }
    });

    // `ws` hands us Buffers. Relaying one verbatim sends a BINARY frame, which
    // the realtime API rejects outright ("binary frames are not supported") —
    // so both directions are coerced to text.
    client.on("message", (data) => {
      const text = data.toString();
      if (upstreamReady && upstream.readyState === WebSocket.OPEN) {
        upstream.send(text);
      } else {
        pending.push(text);
      }
    });

    // `think` is intercepted here and answered by a second model; every other
    // event is relayed untouched. Continuation is deferred the same way the
    // browser defers its own: `response.create` may only be sent once the
    // response that asked for the tool has closed, or the API rejects it with
    // `conversation_already_has_active_response`.
    let responseOpen = false;
    let thinkContinuationPending = false;

    const sendContinuationIfReady = () => {
      if (!responseOpen && thinkContinuationPending) {
        thinkContinuationPending = false;
        upstream.send(JSON.stringify({ type: "response.create" }));
      }
    };

    const answerThinkCall = async (message) => {
      let question = "";
      try {
        question = JSON.parse(message.arguments ?? "{}").question ?? "";
      } catch {
        question = "";
      }

      // Surface it in the sidebar transcript. A custom type, deliberately not a
      // realtime protocol event, so the browser shows it but never tries to run
      // it as a canvas tool or answer the call a second time.
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: "app.thinking", question }));
      }

      let output;
      try {
        output = await runThink(question);
      } catch (error) {
        console.error("[realtime think]", error.message);
        output = `Error: ${error.message}`;
      }

      upstream.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: message.call_id,
            output,
          },
        }),
      );

      // The answer can land before or after the asking response closes, so ask
      // to continue through the same gate either way.
      thinkContinuationPending = true;
      sendContinuationIfReady();
    };

    upstream.on("message", (data) => {
      const text = data.toString();

      let message;
      try {
        message = JSON.parse(text);
      } catch {
        if (client.readyState === WebSocket.OPEN) {
          client.send(text);
        }
        return;
      }

      if (message.type === "response.created") {
        responseOpen = true;
      }
      if (message.type === "response.done") {
        responseOpen = false;
        sendContinuationIfReady();
      }

      if (
        message.type === "response.function_call_arguments.done" &&
        message.name === "think"
      ) {
        void answerThinkCall(message);
        return;
      }

      if (client.readyState === WebSocket.OPEN) {
        client.send(text);
      }
    });

    const closeBoth = () => {
      if (client.readyState === WebSocket.OPEN) {
        client.close();
      }
      if (
        upstream.readyState === WebSocket.OPEN ||
        upstream.readyState === WebSocket.CONNECTING
      ) {
        upstream.close();
      }
    };

    upstream.on("close", closeBoth);
    client.on("close", closeBoth);

    upstream.on("error", (error) => {
      console.error("[realtime upstream]", error.message);
      if (client.readyState === WebSocket.OPEN) {
        client.send(
          JSON.stringify({
            type: "error",
            error: { message: `Voice backend error: ${error.message}` },
          }),
        );
      }
      closeBoth();
    });

    client.on("error", closeBoth);
  });

  console.log(
    `[excalidraw-web-mcp] realtime voice ready on /api/realtime (${DEPLOYMENT}, think -> ${thinkDeployment()})`,
  );
};
