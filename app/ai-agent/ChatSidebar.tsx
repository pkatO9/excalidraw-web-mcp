import { Sidebar, useExcalidrawAPI } from "@excalidraw/excalidraw";
import { useCallback, useEffect, useRef, useState } from "react";

import { executeTool, get_scene } from "./toolLayer";

import "./ChatSidebar.scss";

export const AI_SIDEBAR_NAME = "ai-agent";

const API_BASE =
  (import.meta as any).env?.VITE_AGENT_API || "http://localhost:8787";

/** Hard stop so a confused model cannot spin forever against the canvas. */
const MAX_TURNS = 12;

/** Message shape the backend speaks (see server/src/index.js). */
type AgentMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string;
      raw?: unknown;
      toolCalls?: { id: string; name: string; input: unknown }[];
    }
  | {
      role: "tool";
      results: {
        id: string;
        name: string;
        content: string;
        isError?: boolean;
      }[];
    };

/** What the user actually sees in the transcript. */
type ChatEntry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; text: string; failed: boolean }
  | { kind: "error"; text: string };

export const AIChatSidebar = () => {
  const excalidrawAPI = useExcalidrawAPI();

  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  // The full conversation in the backend's format. Kept in a ref because the
  // agent loop mutates it across several awaits within a single send.
  const history = useRef<AgentMessage[]>([]);
  const transcriptRef = useRef<HTMLDivElement>(null);

  const append = useCallback((entry: ChatEntry) => {
    setEntries((current) => [...current, entry]);
  }, []);

  useEffect(() => {
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [entries]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || busy || !excalidrawAPI) {
      return;
    }

    setInput("");
    append({ kind: "user", text });
    setBusy(true);

    try {
      history.current.push({ role: "user", content: text });

      // The model is handed the live scene on every user turn, so it always
      // positions against real coordinates rather than remembered ones.
      const scene = get_scene(excalidrawAPI);

      for (let turn = 0; turn < MAX_TURNS; turn++) {
        const response = await fetch(`${API_BASE}/api/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messages: history.current,
            ...(turn === 0 ? { scene } : {}),
          }),
        });

        const data = await response.json();

        if (!response.ok) {
          append({ kind: "error", text: data?.error || "Request failed." });
          return;
        }

        history.current.push(data.message);

        if (data.type === "final") {
          append({ kind: "assistant", text: data.message.content });
          return;
        }

        const results = data.message.toolCalls.map(
          (call: { id: string; name: string; input: unknown }) => {
            const outcome = executeTool(excalidrawAPI, call.name, call.input);

            append({
              kind: "tool",
              text: outcome.ok
                ? describeCall(call.name, call.input)
                : `${call.name} failed: ${outcome.error}`,
              failed: !outcome.ok,
            });

            return {
              id: call.id,
              name: call.name,
              content: outcome.ok
                ? JSON.stringify(outcome.result)
                : `Error: ${outcome.error}`,
              ...(outcome.ok ? {} : { isError: true }),
            };
          },
        );

        history.current.push({ role: "tool", results });
      }

      append({
        kind: "error",
        text: `Stopped after ${MAX_TURNS} turns without finishing.`,
      });
    } catch (error) {
      append({
        kind: "error",
        text:
          error instanceof Error
            ? `${error.message} — is the backend running on ${API_BASE}?`
            : String(error),
      });
    } finally {
      setBusy(false);
    }
  }, [append, busy, excalidrawAPI, input]);

  return (
    <Sidebar name={AI_SIDEBAR_NAME} docked>
      <Sidebar.Header>
        <div className="ai-chat__title">AI Diagram Agent</div>
      </Sidebar.Header>

      <div className="ai-chat">
        <div className="ai-chat__transcript" ref={transcriptRef}>
          {entries.length === 0 && (
            <div className="ai-chat__empty">
              <p>Describe a diagram and it will be drawn on the canvas.</p>
              <button
                type="button"
                className="ai-chat__suggestion"
                onClick={() =>
                  setInput(
                    "draw a 3-tier architecture with a load balancer, two app servers, and a database",
                  )
                }
              >
                draw a 3-tier architecture with a load balancer, two app
                servers, and a database
              </button>
            </div>
          )}

          {entries.map((entry, index) => (
            <div
              key={index}
              className={`ai-chat__entry ai-chat__entry--${entry.kind}${
                entry.kind === "tool" && entry.failed
                  ? " ai-chat__entry--failed"
                  : ""
              }`}
            >
              {entry.text}
            </div>
          ))}

          {busy && <div className="ai-chat__entry ai-chat__entry--busy">…</div>}
        </div>

        <form
          className="ai-chat__composer"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <textarea
            className="ai-chat__input"
            value={input}
            rows={3}
            placeholder="e.g. now add a cache next to the database"
            disabled={busy}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />
          <button
            type="submit"
            className="ai-chat__send"
            disabled={busy || !input.trim()}
          >
            {busy ? "Drawing…" : "Send"}
          </button>
        </form>
      </div>
    </Sidebar>
  );
};

/** Floating button that opens the sidebar. Rendered outside <Excalidraw>. */
export const AIChatToggle = () => {
  const excalidrawAPI = useExcalidrawAPI();

  if (!excalidrawAPI) {
    return null;
  }

  return (
    <button
      type="button"
      className="ai-chat__toggle"
      title="Open the AI diagram agent"
      onClick={() => excalidrawAPI.toggleSidebar({ name: AI_SIDEBAR_NAME })}
    >
      Ask AI
    </button>
  );
};

const describeCall = (name: string, input: any): string => {
  switch (name) {
    case "get_scene":
      return "read the canvas";
    case "add_rectangle":
      return `added “${input.label}” at (${input.x}, ${input.y})`;
    case "add_text":
      return `added text “${input.text}” at (${input.x}, ${input.y})`;
    case "bind_arrow":
      return "connected two elements with an arrow";
    case "remove_element":
      return "removed an element";
    default:
      return name;
  }
};
