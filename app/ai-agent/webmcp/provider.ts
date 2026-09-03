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
 * Where the browser implements the API we register with it and an external
 * agent can reach the same tools. Where it does not, we install a shim with the
 * same shape, so the app behaves identically and the code has only one path.
 * `getProviderMode()` reports which is in play; nothing else needs to care.
 *
 * Two things about the platform API are not what the early proposal said, and
 * both were found the hard way — by reading the strings in Chrome 152 rather
 * than the explainer:
 *
 *   - It is `document.modelContext`, not `navigator.modelContext`. Chrome has a
 *     `DocumentModelcontext` feature and an error message that names the path
 *     outright: "document.modelContext cannot be used when document.domain is
 *     enabled." We look in both places, because polyfills and the older draft
 *     use `navigator` and there is no cost to checking.
 *   - There is no `provideContext`. Chrome exposes `registerTool(tool, {signal})`
 *     — one call per tool, asynchronous, and withdrawal is by aborting the
 *     signal, not by an `unregisterTool` method. `publishTo` handles that shape
 *     and the batch shape both.
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

/** Chrome's `ModelContextRegisterToolOptions`. */
type RegisterToolOptions = { signal?: AbortSignal };

type ModelContextLike = {
  /** The early draft, our shim, and most polyfills. */
  provideContext?: (context: { tools: WebMcpTool[] }) => void;
  /** Chrome 152. Returns a promise; `signal` withdraws the tool. */
  registerTool?: (tool: WebMcpTool, options?: RegisterToolOptions) => unknown;
  /** Polyfills that predate the abort-signal withdrawal. */
  unregisterTool?: (name: string) => void;
  getTools?: () => unknown;
};

/**
 * Every object the API might hang off, in the order we trust them: the
 * platform's own placement first.
 */
const hostObjects = (): any[] =>
  typeof document === "undefined" ? [navigator] : [document, navigator];

const SHIM_FLAG = "__excalidrawWebMcpShim";

let mode: ProviderMode = "shim";
let registered: WebMcpTool[] = [];

/**
 * The canvas the tools are bound to, kept so `callTool` can re-register if it
 * ever finds the local cache empty. See `findTool`.
 */
let providerApi: ExcalidrawImperativeAPI | null = null;

/** Aborting this withdraws the tools we registered one at a time. */
let registrationAbort: AbortController | null = null;

export type ProviderStatus = { mode: ProviderMode; count: number };

/**
 * Which provider is in play is not decided once and for all. A browser or an
 * extension can expose `navigator.modelContext` after the editor has already
 * mounted, and when that happens the surface changes underneath the UI — so
 * anything displaying it has to be told, not asked once.
 */
const listeners = new Set<(status: ProviderStatus) => void>();

const notify = () => {
  const status: ProviderStatus = { mode, count: registered.length };
  for (const listener of listeners) {
    listener(status);
  }
};

/** Watch the provider mode. Returns an unsubscribe. */
export const subscribeProvider = (
  listener: (status: ProviderStatus) => void,
) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

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
  // Not a plain assignment. Something else may install the real thing after
  // us — a browser that exposes the API late, or an extension whose content
  // script is injected when the user activates it, which is well after the
  // editor mounts. A plain assignment leaves our shim sitting there as the
  // answer to `if (!document.modelContext)`, so the injector either declines
  // to install (the browser never learns this page has tools) or overwrites us
  // and our declarations vanish with no re-register.
  //
  // An accessor makes the handover explicit: whoever assigns wins, and we
  // notice and hand our tools over. The property stays configurable, so an
  // injector that uses defineProperty instead of assignment also succeeds —
  // that case is caught by the poll in `startWatchingForNative`.
  // One holder behind every host, so `document.modelContext` and
  // `navigator.modelContext` never disagree about what is installed.
  const holder: { current: ModelContextLike } = { current: shim };

  const installOn = (host: any) => {
    // Never shadow a name the platform already defines. If Chrome has the
    // attribute but it reads empty right now, an own property of ours would
    // hide the real implementation for good — the worst outcome available.
    if ("modelContext" in host) {
      return;
    }
    try {
      Object.defineProperty(host, "modelContext", {
        configurable: true,
        enumerable: true,
        get: () => holder.current,
        set: (incoming: ModelContextLike) => {
          holder.current = incoming;
          adoptIfNative();
        },
      });
    } catch {
      // Some engine refused the accessor; a plain assignment still gets the
      // app working, just without the automatic handover.
      try {
        host.modelContext = shim;
      } catch {
        // and this host is simply not writable — try the next one
      }
    }
  };

  for (const host of hostObjects()) {
    installOn(host);
  }
  return shim;
};

const isShim = (context: unknown) => Boolean((context as any)?.[SHIM_FLAG]);

/**
 * Hand the current declarations to a context object.
 *
 * Split out of `registerCanvasTools` because it is also what a handover needs:
 * when a native implementation turns up mid-session, the tools it must be told
 * about are the ones already built for the live canvas.
 */
const publishTo = (context: ModelContextLike) => {
  // Withdraw the previous registration first. On a remount the same eight
  // names go up again, and Chrome throws InvalidStateError on a duplicate.
  withdrawRegistration();

  if (context.provideContext) {
    context.provideContext({ tools: registered });
    return;
  }

  if (!context.registerTool) {
    return;
  }

  // Chrome's shape: one call per tool, asynchronous, withdrawn by aborting the
  // signal handed in with it.
  const controller =
    typeof AbortController === "undefined" ? null : new AbortController();
  registrationAbort = controller;

  for (const tool of registered) {
    try {
      // Polyfills that predate the signal offer this instead; harmless where
      // nothing is registered under the name yet.
      context.unregisterTool?.(tool.name);
    } catch {
      // nothing registered under that name yet
    }

    try {
      const outcome = context.registerTool(
        tool,
        controller ? { signal: controller.signal } : undefined,
      );
      // registerTool is async: a rejection here is the browser refusing the
      // declaration, which is worth saying out loud rather than swallowing.
      void Promise.resolve(outcome).catch((error) =>
        reportRegistrationFailure(tool.name, error),
      );
    } catch (error) {
      reportRegistrationFailure(tool.name, error);
    }
  }
};

/**
 * Tools are withdrawn by aborting the signal they were registered with — the
 * platform has no `unregisterTool`.
 */
const withdrawRegistration = () => {
  registrationAbort?.abort();
  registrationAbort = null;
};

const reportRegistrationFailure = (name: string, error: unknown) => {
  // eslint-disable-next-line no-console
  console.warn(
    `WebMCP: the browser refused the "${name}" tool declaration.`,
    error,
  );
};

/**
 * If a real implementation is on `navigator` now, switch to it.
 *
 * Returns whether the handover happened, so the poll can stop.
 */
const adoptIfNative = () => {
  const context = nativeContext();
  if (!context) {
    return false;
  }

  mode = "native";
  publishTo(context);
  stopWatchingForNative();
  notify();
  return true;
};

/** How long to keep looking for a native implementation, and how often. */
const NATIVE_WATCH_INTERVAL_MS = 500;
const NATIVE_WATCH_WINDOW_MS = 30_000;

let watchTimer: ReturnType<typeof setInterval> | null = null;
let watchingEvents = false;

const onMaybeNative = () => {
  adoptIfNative();
};

/**
 * Look for a native implementation arriving after we have already fallen back
 * to the shim.
 *
 * The accessor in `installShim` catches an assignment; this catches the rest —
 * a defineProperty that replaces our accessor outright, and an extension that
 * only injects once the user activates it, which can be minutes later. Hence
 * the focus and visibility checks outliving the poll: coming back to the tab
 * after enabling something is exactly when a new provider tends to appear.
 */
const startWatchingForNative = () => {
  if (typeof window === "undefined") {
    return;
  }

  if (!watchTimer) {
    const deadline = Date.now() + NATIVE_WATCH_WINDOW_MS;
    watchTimer = setInterval(() => {
      if (adoptIfNative()) {
        return;
      }
      if (Date.now() >= deadline && watchTimer) {
        clearInterval(watchTimer);
        watchTimer = null;
      }
    }, NATIVE_WATCH_INTERVAL_MS);
  }

  if (!watchingEvents) {
    window.addEventListener("focus", onMaybeNative);
    document.addEventListener("visibilitychange", onMaybeNative);
    watchingEvents = true;
  }
};

const stopWatchingForNative = () => {
  if (watchTimer) {
    clearInterval(watchTimer);
    watchTimer = null;
  }
  if (watchingEvents) {
    window.removeEventListener("focus", onMaybeNative);
    document.removeEventListener("visibilitychange", onMaybeNative);
    watchingEvents = false;
  }
};

/** Whatever is currently installed, ours or the platform's. */
const currentContext = (): ModelContextLike | undefined => {
  for (const host of hostObjects()) {
    const context = host?.modelContext as ModelContextLike | undefined;
    if (context) {
      return context;
    }
  }
  return undefined;
};

/** The platform's own implementation, if one of the hosts has it. */
const nativeContext = (): ModelContextLike | undefined => {
  for (const host of hostObjects()) {
    const context = host?.modelContext as ModelContextLike | undefined;
    if (context && !isShim(context)) {
      return context;
    }
  }
  return undefined;
};

const getModelContext = (): ModelContextLike => {
  const native = nativeContext();
  if (native) {
    mode = "native";
    return native;
  }

  const existing = currentContext();
  mode = "shim";
  return existing ?? installShim();
};

/**
 * Declare every canvas tool to the browser. Safe to call again — re-registering
 * replaces the previous set, which is what we want when the editor remounts.
 */
export const registerCanvasTools = (api: ExcalidrawImperativeAPI) => {
  const context = getModelContext();
  providerApi = api;
  registered = TOOL_DECLARATIONS.map((declaration) =>
    toWebMcpTool(declaration, api),
  );

  publishTo(context);

  // Running on the shim is a fallback, not a verdict: keep looking for the
  // real thing rather than reporting "shim" for the life of the page.
  if (mode === "shim") {
    startWatchingForNative();
  } else {
    stopWatchingForNative();
  }

  notify();
  return { mode, count: registered.length };
};

export const unregisterCanvasTools = () => {
  withdrawRegistration();

  const context = currentContext();
  if (context?.provideContext) {
    context.provideContext({ tools: [] });
  } else if (context?.unregisterTool) {
    for (const tool of registered) {
      try {
        context.unregisterTool(tool.name);
      } catch {
        // already gone
      }
    }
  }
  registered = [];
  providerApi = null;
  stopWatchingForNative();
  notify();
};

/**
 * Resolve a declared tool to something callable.
 *
 * `registered` is a module-level cache, and there are two ways for it to go
 * empty while the page is very much still a working tool provider. A dev hot
 * reload re-evaluates this module, resetting the array while the provider
 * object living on `navigator` keeps the real registry. And the registration
 * effect is keyed on the editor API, so a transient change there runs the
 * cleanup and leaves a window with nothing cached.
 *
 * Either way the tools ARE registered and the canvas IS reachable, so failing
 * the call would be a lie told on the strength of our own bookkeeping. This
 * was not theoretical: it surfaced as every tool call in a session returning
 * `declared but not registered yet` until the page was reloaded.
 *
 * So: prefer the cache, fall back to the live registry, and rebuild the cache
 * from the canvas as a last resort.
 */
const findTool = (name: string): WebMcpTool | undefined => {
  const cached = registered.find((candidate) => candidate.name === name);
  if (cached) {
    return cached;
  }

  const live = (currentContext() as any)?.__tools as WebMcpTool[] | undefined;
  const fromRegistry = live?.find((candidate) => candidate.name === name);
  if (fromRegistry) {
    return fromRegistry;
  }

  if (providerApi) {
    registerCanvasTools(providerApi);
    return registered.find((candidate) => candidate.name === name);
  }

  return undefined;
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

  const tool = findTool(name);
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
