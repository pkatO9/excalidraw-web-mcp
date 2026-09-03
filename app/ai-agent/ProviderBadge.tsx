import { useCallback, useEffect, useId, useRef, useState } from "react";

import { TOOL_DECLARATIONS } from "./webmcp/descriptors";
import { getRegisteredTools } from "./webmcp/provider";

import type { ProviderMode } from "./webmcp/provider";

/**
 * The WebMCP badge in the panel header, and the tool list behind it.
 *
 * The badge already said the one thing that matters — whether the browser
 * implements WebMCP or we are on the shim. Opening it answers the obvious next
 * question: *which* tools, then. That list is worth showing rather than
 * describing, because under WebMCP the page's manifest is the contract; this is
 * the same thing an agent discovers, read straight out of the live registry.
 *
 * So the descriptions here are the real ones, shouty capitals and all, not a
 * prettier UI copy of them. A second set of words would drift from the first,
 * and the honest version is also the more interesting one to look at.
 */

const CHEVRON = (
  <svg
    className="ai-chat__webmcp-chevron"
    width="10"
    height="10"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="3"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M6 9l6 6 6-6" />
  </svg>
);

/**
 * Descriptions are written for a model, so they run long. The first sentence is
 * the summary the rest elaborates on; the full text is a hover away.
 */
const firstSentence = (text: string) => {
  const end = text.match(/^.*?\.(\s|$)/);
  return (end ? end[0] : text).trim();
};

/** Parameter names, required ones first — the shape of a call at a glance. */
const parameters = (inputSchema: Record<string, unknown>) => {
  const properties = (inputSchema.properties ?? {}) as Record<string, unknown>;
  const required = new Set(
    Array.isArray(inputSchema.required)
      ? (inputSchema.required as string[])
      : [],
  );
  return Object.keys(properties)
    .map((name) => ({ name, required: required.has(name) }))
    .sort((a, b) => Number(b.required) - Number(a.required));
};

export const ProviderBadge = ({
  mode,
  count,
}: {
  mode: ProviderMode;
  count: number;
}) => {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const panelId = useId();

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) {
      buttonRef.current?.focus();
    }
  }, []);

  // Dismissal, the two ways anything in the editor is dismissed.
  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // The sidebar closes on Escape too, and losing the whole panel when you
        // meant to close a popover inside it is a bad trade.
        event.stopPropagation();
        close(true);
      }
    };

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !popoverRef.current?.contains(target) &&
        !buttonRef.current?.contains(target)
      ) {
        close(false);
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("mousedown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("mousedown", onPointerDown);
    };
  }, [close, open]);

  // Read the registry, not the module's own declarations — what an agent can
  // actually call is the point, and on the shim those can differ.
  const tools = open
    ? getRegisteredTools().length
      ? getRegisteredTools()
      : TOOL_DECLARATIONS
    : [];

  const native = mode === "native";

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`ai-chat__webmcp ai-chat__webmcp--${mode}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? panelId : undefined}
        title={
          native
            ? "This browser implements the WebMCP API (document.modelContext); the canvas is registered with it and any agent the browser trusts can discover these tools. Click to see them."
            : "This browser has not exposed document.modelContext or navigator.modelContext, so a spec-shaped shim is in use. Same code path, but only this page can see the tools — an external agent cannot. Click to see them."
        }
        onClick={() => setOpen((current) => !current)}
      >
        WebMCP · {mode} · {count} tools
        {CHEVRON}
      </button>

      {open && (
        <div
          ref={popoverRef}
          id={panelId}
          className="ai-chat__tools"
          role="dialog"
          aria-label="Tools this page declares"
        >
          <p className="ai-chat__tools-lede">
            {native ? (
              <>
                Registered with <code>document.modelContext</code>. Any agent
                the browser trusts can discover and call these.
              </>
            ) : (
              <>
                Declared on a spec-shaped shim, because this browser exposes no{" "}
                <code>modelContext</code>. Only this page can call these.
              </>
            )}
          </p>

          <ul className="ai-chat__tools-list">
            {tools.map((tool) => (
              <li key={tool.name} className="ai-chat__tool">
                <div className="ai-chat__tool-head">
                  <span className="ai-chat__tool-name">{tool.name}</span>
                  <span className="ai-chat__tool-params">
                    {parameters(tool.inputSchema).map((param) => (
                      <span
                        key={param.name}
                        className={
                          param.required
                            ? "ai-chat__tool-param ai-chat__tool-param--required"
                            : "ai-chat__tool-param"
                        }
                        title={
                          param.required
                            ? `${param.name} — required`
                            : `${param.name} — optional`
                        }
                      >
                        {param.name}
                      </span>
                    ))}
                  </span>
                </div>
                <p
                  className="ai-chat__tool-description"
                  title={tool.description}
                >
                  {firstSentence(tool.description)}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
};
