import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { executeTool } from "../toolLayer";

import { DECLARED_TOOL_NAMES, TOOL_DECLARATIONS } from "./descriptors";

import type { ToolDeclaration } from "./descriptors";

/**
 * WebMCP tool provider for the canvas.
 *
 * Under WebMCP the page itself is the tool provider: it declares what it can
 * do through `navigator.modelContext`, and any agent the browser trusts can
 * discover and invoke those tools. That inverts the usual arrangement, where a
 * backend owns the tool list and a bespoke loop is the only caller.
 *
 * This module is the whole of that surface. Everything that drives the canvas
 * — including our own sidebar and voice agent — goes through it, so the
 * WebMCP path is exercised on every single interaction rather than sitting
 * beside the real code path slowly rotting.
 *
 * Where the browser implements `navigator.modelContext`, we register with it
 * and an external agent can reach the same tools. Where it does not, we install
 * a shim with the same shape, so the app behaves identically and the code has
 * only one path. `getProviderMode()` reports which is in play; nothing else
 * needs to care.
 */

/** Result shape WebMCP expects back from `execute`. */
export type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

export type WebMcpTool = ToolDeclaration & {
  execute: (params: any) => Promise<ToolResult>;
};

export type ProviderMode = "native" | "shim";

type ModelContextLike = {
  provideContext?: (context: { tools: WebMcpTool[] }) => void;
  registerTool?: (tool: WebMcpTool) => void;
  unregisterTool?: (name: string) => void;
};

const SHIM_FLAG = "__excalidrawWebMcpShim";

let mode: ProviderMode = "shim";
let registered: WebMcpTool[] = [];

const asText = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value ?? null);

/**
 * Wrap a canvas tool as a WebMCP tool.
 *
 * `execute` is async because WebMCP's is: an agent may await a tool that opens
 * a dialog or waits on the user. Ours resolve immediately today, but the
 * signature has to be the honest one or callers would be written against a
 * contract the platform does not offer.
 *
 * A failing tool resolves with `isError` rather than rejecting. An agent needs
 * to read the failure and try something else; a rejected promise would abort
 * its turn instead.
 */
const toWebMcpTool = (
  declaration: ToolDeclaration,
  api: ExcalidrawImperativeAPI,
): WebMcpTool => ({
  ...declaration,
  execute: async (params: unknown) => {
    const outcome = executeTool(api, declaration.name, params ?? {});
    return outcome.ok
      ? { content: [{ type: "text" as const, text: asText(outcome.result) }] }
      : {
          content: [{ type: "text" as const, text: outcome.error }],
          isError: true,
        };
  },
});

/**
 * Minimal stand-in for the platform object, matching the parts of the spec we
 * use. Installed only when the browser has none, so a single code path serves
 * both. It is deliberately marked, so `getProviderMode()` can tell the two
 * apart and say so out loud in the UI rather than quietly implying native
 * support that is not there.
 */
const installShim = (): ModelContextLike => {
  const tools = new Map<string, WebMcpTool>();
  const shim: ModelContextLike & {
    [SHIM_FLAG]?: true;
    __tools?: WebMcpTool[];
  } = {
    [SHIM_FLAG]: true,
    // Shim-only. With a native implementation the browser brokers discovery
    // and hands tools to whichever agent it trusts; with no browser in the
    // middle, an in-page agent needs somewhere to read the manifest from.
    // Deliberately not part of the spec surface.
    get __tools() {
      return [...tools.values()];
    },
    provideContext: ({ tools: next }) => {
      tools.clear();
      for (const tool of next) {
        tools.set(tool.name, tool);
      }
    },
    registerTool: (tool) => {
      if (tools.has(tool.name)) {
        // Mirrors the spec, which throws InvalidStateError on a duplicate.
        throw new DOMException(
          `Tool "${tool.name}" is already registered.`,
          "InvalidStateError",
        );
      }
      tools.set(tool.name, tool);
    },
    unregisterTool: (name) => {
      tools.delete(name);
    },
  };
  (navigator as any).modelContext = shim;
  return shim;
};

const getModelContext = (): ModelContextLike => {
  const existing = (navigator as any).modelContext as
    | ModelContextLike
    | undefined;
  if (existing) {
    mode = (existing as any)[SHIM_FLAG] ? "shim" : "native";
    return existing;
  }
  mode = "shim";
  return installShim();
};

/**
 * Declare every canvas tool to the browser. Safe to call again — re-registering
 * replaces the previous set, which is what we want when the editor remounts.
 */
export const registerCanvasTools = (api: ExcalidrawImperativeAPI) => {
  const context = getModelContext();
  registered = TOOL_DECLARATIONS.map((declaration) =>
    toWebMcpTool(declaration, api),
  );

  if (context.provideContext) {
    context.provideContext({ tools: registered });
  } else if (context.registerTool) {
    // Older shape: no batch call, so register one at a time and tolerate the
    // duplicates a remount would otherwise throw on.
    for (const tool of registered) {
      try {
        context.unregisterTool?.(tool.name);
      } catch {
        // nothing registered under that name yet
      }
      context.registerTool(tool);
    }
  }

  return { mode, count: registered.length };
};

export const unregisterCanvasTools = () => {
  const context = (navigator as any).modelContext as
    | ModelContextLike
    | undefined;
  if (!context) {
    return;
  }
  if (context.provideContext) {
    context.provideContext({ tools: [] });
  } else if (context.unregisterTool) {
    for (const tool of registered) {
      context.unregisterTool(tool.name);
    }
  }
  registered = [];
};

export const getProviderMode = (): ProviderMode => mode;

/** What is currently declared — the same list an agent would discover. */
export const getRegisteredTools = (): WebMcpTool[] => registered;

/**
 * Invoke a tool the way an agent would.
 *
 * Our own sidebar and voice agent call this rather than reaching into the
 * canvas directly. That is the point of the exercise: if this path breaks, the
 * product breaks, so it cannot quietly stop working.
 */
export const callTool = async (
  name: string,
  params: unknown,
): Promise<{ ok: true; result: string } | { ok: false; error: string }> => {
  if (!DECLARED_TOOL_NAMES.has(name)) {
    return { ok: false, error: `Unknown tool "${name}".` };
  }

  const tool = registered.find((candidate) => candidate.name === name);
  if (!tool) {
    return {
      ok: false,
      error: `Tool "${name}" is declared but not registered yet.`,
    };
  }

  try {
    const result = await tool.execute(params ?? {});
    const text = result.content.map((part) => part.text).join("\n");
    return result.isError
      ? { ok: false, error: text }
      : { ok: true, result: text };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

/**
 * The declarations an agent would see, in the Anthropic/OpenAI wire shape the
 * backend forwards to a model. The browser sends this with each request so the
 * server no longer has to keep its own definition of what the canvas can do.
 */
export const toolsForModel = () =>
  TOOL_DECLARATIONS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
