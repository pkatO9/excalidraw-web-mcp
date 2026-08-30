import { useExcalidrawAPI } from "@excalidraw/excalidraw";
import { useCallback, useEffect, useRef, useState } from "react";

import { API_BASE } from "./config";
import { VoiceAgent } from "./voiceAgent";

import type { VoiceStatus } from "./voiceAgent";
import type { ChatEntry } from "./types/chat";

/**
 * The Talk / End button and its live status line.
 *
 * The session itself lives in `VoiceAgent`, outside React, because audio
 * scheduling and the socket must not be torn down and rebuilt on every render.
 * This component owns only the toggle and the status label, and forwards the
 * agent's transcript into the same chat log the typed agent writes to — so a
 * spoken conversation and a typed one read as one thread.
 */

const STATUS_LABEL: Record<VoiceStatus, string> = {
  idle: "",
  connecting: "connecting…",
  listening: "listening",
  thinking: "thinking…",
  speaking: "speaking",
};

type VoiceControlsProps = {
  onEntry: (entry: ChatEntry) => void;
  /** Keep the typed agent's history in step with what was said aloud. */
  onTranscript: (role: "user" | "assistant", content: string) => void;
};

export const VoiceControls = ({
  onEntry,
  onTranscript,
}: VoiceControlsProps) => {
  const excalidrawAPI = useExcalidrawAPI();
  const [status, setStatus] = useState<VoiceStatus>("idle");
  const agentRef = useRef<VoiceAgent | null>(null);

  // Callbacks are read through a ref so re-renders never rebuild the session.
  const sinks = useRef({ onEntry, onTranscript });
  sinks.current = { onEntry, onTranscript };

  useEffect(
    () => () => {
      agentRef.current?.stop();
      agentRef.current = null;
    },
    [],
  );

  const toggle = useCallback(() => {
    if (agentRef.current) {
      agentRef.current.stop();
      agentRef.current = null;
      return;
    }
    if (!excalidrawAPI) {
      return;
    }

    const agent = new VoiceAgent(excalidrawAPI, API_BASE, {
      onStatus: (next) => {
        setStatus(next);
        if (next === "idle") {
          agentRef.current = null;
        }
      },
      onUserTranscript: (text) => {
        sinks.current.onEntry({ kind: "user", text });
        sinks.current.onTranscript("user", text);
      },
      onAgentTranscript: (text) => {
        sinks.current.onEntry({ kind: "assistant", text });
        sinks.current.onTranscript("assistant", text);
      },
      onToolRun: (text, failed) =>
        sinks.current.onEntry({ kind: "tool", text, failed }),
      onError: (message) =>
        sinks.current.onEntry({ kind: "error", text: message }),
    });

    agentRef.current = agent;
    void agent.start();
  }, [excalidrawAPI]);

  const live = status !== "idle";

  return (
    <button
      type="button"
      className={`ai-chat__voice${live ? " ai-chat__voice--live" : ""}`}
      aria-pressed={live}
      title={live ? "End the voice conversation" : "Talk to the agent out loud"}
      onClick={toggle}
    >
      <SpeechIcon />
      <span>{live ? STATUS_LABEL[status] || "live" : "Talk"}</span>
    </button>
  );
};

const SpeechIcon = () => (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
  </svg>
);
