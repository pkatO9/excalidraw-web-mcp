import {
  Sidebar,
  useExcalidrawAPI,
  useExcalidrawStateValue,
} from "@excalidraw/excalidraw";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { API_BASE } from "./config";
import { get_scene } from "./toolLayer";
import {
  callTool,
  registerCanvasTools,
  subscribeProvider,
  toolsForModel,
  unregisterCanvasTools,
} from "./webmcp/provider";
import { TutorControls } from "./TutorControls";
import { VoiceControls } from "./VoiceControls";
import { useDictation } from "./useDictation";
import { useResizableSidebar } from "./useResizableSidebar";

import "./ChatSidebar.scss";

import type { SceneElementSummary } from "./toolLayer";
import type { AgentMessage, ChatEntry } from "./types/chat";

export const AI_SIDEBAR_NAME = "ai-agent";

/** Hard stop so a confused model cannot spin forever against the canvas. */
const MAX_TURNS = 12;

/**
 * How many reference pills to show before collapsing behind a "+N" chip.
 * Selecting everything on a busy canvas otherwise buries the composer under
 * thirty pills. All of them are still sent — this only bounds what is drawn.
 */
const COLLAPSED_REFERENCE_COUNT = 4;

/** Labels echoed into the transcript before it summarises the rest. */
const ECHOED_REFERENCE_COUNT = 3;

/**
 * Short echo of what a message referred to. Selecting a whole diagram would
 * otherwise print thirty labels into the transcript.
 */
const summariseReferences = (refs: SceneElementSummary[]) => {
  const shown = refs.slice(0, ECHOED_REFERENCE_COUNT).map(describeReference);
  const rest = refs.length - shown.length;
  return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
};

/** Human-readable name for a referenced element, for the pill. */
const describeReference = (el: SceneElementSummary) =>
  el.label?.trim() || el.type;

/**
 * Canvas selection -> chat references.
 *
 * Mirrors how an editor selection becomes a reference in a coding agent: what
 * you have selected on the canvas is what "this"/"these" means in your next
 * message. Pills track the live selection; dismissing one drops it until that
 * element is selected again.
 */
const useSelectionReferences = (
  excalidrawAPI: ReturnType<typeof useExcalidrawAPI>,
) => {
  const selectedElementIds = useExcalidrawStateValue("selectedElementIds");
  const [dismissed, setDismissed] = useState<string[]>([]);

  const selectedIds = useMemo(
    () => Object.keys(selectedElementIds ?? {}),
    [selectedElementIds],
  );

  // Forget dismissals for elements that are no longer selected, so reselecting
  // an element brings its pill back rather than silently staying hidden.
  useEffect(() => {
    setDismissed((current) => {
      const next = current.filter((id) => selectedIds.includes(id));
      return next.length === current.length ? current : next;
    });
  }, [selectedIds]);

  const references = useMemo(() => {
    if (!excalidrawAPI || selectedIds.length === 0) {
      return [];
    }
    const wanted = new Set(selectedIds.filter((id) => !dismissed.includes(id)));
    return get_scene(excalidrawAPI).filter((el) => wanted.has(el.id));
  }, [excalidrawAPI, selectedIds, dismissed]);

  const dismiss = useCallback((id: string) => {
    setDismissed((current) =>
      current.includes(id) ? current : [...current, id],
    );
  }, []);

  const clear = useCallback(() => setDismissed([]), []);

  return { references, dismiss, clear };
};

export const AIChatSidebar = () => {
  const excalidrawAPI = useExcalidrawAPI();

  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  const { references, dismiss, clear } = useSelectionReferences(excalidrawAPI);
  const [provider, setProvider] = useState<{
    mode: string;
    count: number;
  } | null>(null);

  // Declare the canvas to the browser for as long as the editor is mounted, so
  // an agent can discover it. Our own agents call the very same tools through
  // `callTool`, which is what keeps this surface honest.
  //
  // Subscribed rather than read once: a browser or extension can expose
  // `navigator.modelContext` after the editor has mounted, and the provider
  // hands the tools over when it does. Reading the mode once left the badge
  // saying "shim" for the rest of the session even though the page had since
  // become a real WebMCP provider.
  useEffect(() => {
    if (!excalidrawAPI) {
      return undefined;
    }
    const unsubscribe = subscribeProvider(setProvider);
    setProvider(registerCanvasTools(excalidrawAPI));
    return () => {
      unsubscribe();
      unregisterCanvasTools();
    };
  }, [excalidrawAPI]);
  const [referencesExpanded, setReferencesExpanded] = useState(false);
  const { onResizeStart, resetWidth } = useResizableSidebar();
  const { listening, speechSupported, toggleDictation, stopDictation } =
    useDictation(input, setInput);

  // The full conversation in the backend's format. Kept in a ref because the
  // agent loop mutates it across several awaits within a single send.
  const history = useRef<AgentMessage[]>([]);
  const transcriptRef = useRef<HTMLDivElement>(null);

  const append = useCallback((entry: ChatEntry) => {
    setEntries((current) => [...current, entry]);
  }, []);

  // The finished walkthrough joins the chat history, so a follow-up like
  // "why is there a load balancer?" has the lesson as context. A lesson the
  // model started via teach_diagram is already in the history as a tool call,
  // but the narration itself is not, so it is recorded either way.
  /**
   * Mirror what was said aloud into the typed agent's history, so switching
   * between talking and typing continues one conversation instead of starting
   * a second one that has never heard the first.
   */
  const recordSpoken = useCallback(
    (role: "user" | "assistant", content: string) => {
      history.current.push({ role, content } as AgentMessage);
    },
    [],
  );

  const recordLesson = useCallback((content: string) => {
    history.current.push({ role: "user", content: "Teach me this diagram." });
    history.current.push({ role: "assistant", content });
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

    stopDictation();

    // Snapshot the pills now — the canvas selection changes as the agent draws.
    const attached = references;

    setInput("");
    append({
      kind: "user",
      text: attached.length
        ? `${text}\n↳ referring to ${summariseReferences(attached)}`
        : text,
    });
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
            // The tool list travels with the request: the browser is the tool
            // provider now, so the backend does not keep its own idea of what
            // the canvas can do.
            tools: toolsForModel(),
            ...(turn === 0
              ? {
                  scene,
                  ...(attached.length ? { references: attached } : {}),
                }
              : {}),
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

        // Sequential on purpose. The calls in one turn are usually ordered —
        // create the shapes, then bind arrows between them — so running them
        // concurrently would let a bind fire before its target exists.
        const results = [];
        for (const call of data.message.toolCalls as {
          id: string;
          name: string;
          input: unknown;
        }[]) {
          const outcome = await callTool(call.name, call.input);

          append({
            kind: "tool",
            text: outcome.ok
              ? describeCall(call.name, call.input, safeParse(outcome.result))
              : `${call.name} failed: ${outcome.error}`,
            failed: !outcome.ok,
          });

          results.push({
            id: call.id,
            name: call.name,
            content: outcome.ok ? outcome.result : `Error: ${outcome.error}`,
            ...(outcome.ok ? {} : { isError: true }),
          });
        }

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
      clear();
      setReferencesExpanded(false);
    }
  }, [append, busy, clear, excalidrawAPI, input, references, stopDictation]);

  return (
    <Sidebar name={AI_SIDEBAR_NAME} docked>
      <Sidebar.Header>
        <div className="ai-chat__title">AI Diagram Agent</div>
        {provider && (
          <span
            className={`ai-chat__webmcp ai-chat__webmcp--${provider.mode}`}
            title={
              provider.mode === "native"
                ? "This browser implements the WebMCP API (document.modelContext); the canvas is registered with it and any agent the browser trusts can discover these tools."
                : "This browser has not exposed document.modelContext or navigator.modelContext, so a spec-shaped shim is in use. Same code path, but only this page can see the tools — an external agent cannot. If the browser or an extension provides one later, the canvas is handed over automatically and this switches to native."
            }
          >
            WebMCP · {provider.mode} · {provider.count} tools
          </span>
        )}
      </Sidebar.Header>

      <div className="ai-chat">
        <div
          className="ai-chat__resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the AI panel"
          title="Drag to resize · double-click to reset"
          onPointerDown={onResizeStart}
          onDoubleClick={resetWidth}
        />

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
              <p className="ai-chat__hint">
                Tip: select shapes on the canvas and they become references for
                your next message — then just say “make this blue”.
              </p>
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
          {references.length > 0 && (
            <div
              className={`ai-chat__refs${
                referencesExpanded ? " ai-chat__refs--expanded" : ""
              }`}
              aria-label={`${references.length} referenced element(s)`}
            >
              {(referencesExpanded
                ? references
                : references.slice(0, COLLAPSED_REFERENCE_COUNT)
              ).map((el) => (
                <span key={el.id} className="ai-chat__ref" title={el.id}>
                  <span className="ai-chat__ref-kind">{el.type}</span>
                  <span className="ai-chat__ref-label">
                    {describeReference(el)}
                  </span>
                  <button
                    type="button"
                    className="ai-chat__ref-remove"
                    aria-label={`Remove ${describeReference(el)} reference`}
                    onClick={() => dismiss(el.id)}
                  >
                    ×
                  </button>
                </span>
              ))}

              {references.length > COLLAPSED_REFERENCE_COUNT && (
                <button
                  type="button"
                  className="ai-chat__ref ai-chat__ref--more"
                  aria-expanded={referencesExpanded}
                  title={
                    referencesExpanded
                      ? "Show fewer"
                      : "Show all referenced elements"
                  }
                  onClick={() => setReferencesExpanded((open) => !open)}
                >
                  {referencesExpanded
                    ? "Show less"
                    : `+${references.length - COLLAPSED_REFERENCE_COUNT}`}
                </button>
              )}
            </div>
          )}

          <textarea
            className="ai-chat__input"
            value={input}
            rows={3}
            placeholder={
              references.length
                ? "e.g. make this blue"
                : "e.g. now add a cache next to the database"
            }
            disabled={busy}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
          />

          <div className="ai-chat__actions">
            <button
              type="submit"
              className="ai-chat__send"
              disabled={busy || !input.trim()}
            >
              {busy ? "Drawing…" : "Send"}
            </button>
            {speechSupported && (
              <button
                type="button"
                className={`ai-chat__mic${
                  listening ? " ai-chat__mic--on" : ""
                }`}
                disabled={busy}
                aria-pressed={listening}
                title={listening ? "Stop dictation" : "Dictate a message"}
                onClick={toggleDictation}
              >
                <MicIcon />
              </button>
            )}
            <VoiceControls onEntry={append} onTranscript={recordSpoken} />
            <TutorControls onEntry={append} onAssistantMessage={recordLesson} />
          </div>
        </form>
      </div>
    </Sidebar>
  );
};

const MicIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
    <line x1="12" y1="19" x2="12" y2="22" />
  </svg>
);

/**
 * Opens the sidebar. Rendered inside the editor's top-right cluster, next to the
 * Excalidraw+ and share buttons, and deliberately styled to match them rather
 * than floating over the canvas.
 */
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
      AI
    </button>
  );
};

/** Tool results cross the WebMCP boundary as text; parse for display only. */
const safeParse = (text: string): any => {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
};

const describeCall = (name: string, input: any, result?: any): string => {
  switch (name) {
    case "get_scene":
      return "read the canvas";
    case "add_shape":
    case "add_rectangle":
      return `added “${input.label}” at (${input.x}, ${input.y})`;
    case "add_text":
      return `added text “${input.text}” at (${input.x}, ${input.y})`;
    case "bind_arrow":
      return "connected two elements with an arrow";
    case "set_style":
      return `restyled ${input.ids?.length ?? 0} element(s)`;
    case "teach_diagram":
      return `started a spoken walkthrough of ${
        result?.elements ?? 0
      } element(s)`;
    case "remove_element":
      // A shape takes its bound arrows with it, so a later delete of one of
      // those arrows is a no-op. Say so rather than claiming another removal.
      return result?.already_removed
        ? "already gone (removed with its shape)"
        : `removed ${result?.removed_ids?.length ?? 1} element(s)`;
    default:
      return name;
  }
};
