import { resolvablePromise } from "@excalidraw/common";
import { Excalidraw } from "@excalidraw/excalidraw";
import { render } from "@excalidraw/excalidraw/tests/test-utils";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { get_scene } from "../ai-agent/toolLayer";
import { TOOL_DECLARATIONS } from "../ai-agent/webmcp/descriptors";
import {
  callTool,
  getProviderMode,
  getRegisteredTools,
  registerCanvasTools,
  subscribeProvider,
  toolsForModel,
  unregisterCanvasTools,
} from "../ai-agent/webmcp/provider";

/**
 * The provider is the whole WebMCP surface, and our own agents go through it,
 * so these cover both halves: that the page declares tools the way the spec
 * expects, and that invoking one really changes the canvas.
 *
 * jsdom has no `navigator.modelContext`, so these exercise the shim. The
 * native path is the same code with a different object underneath — what
 * cannot be asserted here is Chrome's own implementation, only the contract.
 */
describe("WebMCP provider", () => {
  let api: ExcalidrawImperativeAPI;

  beforeEach(async () => {
    delete (navigator as any).modelContext;
    delete (document as any).modelContext;
    const p = resolvablePromise<ExcalidrawImperativeAPI>();
    await render(<Excalidraw onExcalidrawAPI={(a) => p.resolve(a as any)} />);
    api = await p;
  });

  afterEach(() => {
    unregisterCanvasTools();
    delete (navigator as any).modelContext;
    delete (document as any).modelContext;
  });

  it("declares every canvas tool on navigator.modelContext", () => {
    const { count } = registerCanvasTools(api);

    expect(count).toBe(TOOL_DECLARATIONS.length);
    expect((navigator as any).modelContext).toBeDefined();
    expect(
      getRegisteredTools()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(TOOL_DECLARATIONS.map((tool) => tool.name).sort());
  });

  it("declares tools in the shape the spec requires", () => {
    registerCanvasTools(api);

    for (const tool of getRegisteredTools()) {
      expect(typeof tool.name).toBe("string");
      expect(tool.name.length).toBeGreaterThan(0);
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema).toMatchObject({ type: "object" });
      expect(typeof tool.execute).toBe("function");
    }
  });

  it("reports shim mode when the browser has no native implementation", () => {
    registerCanvasTools(api);
    // Being explicit matters: the UI says which is in play rather than
    // implying native support that is not there.
    expect(getProviderMode()).toBe("shim");
  });

  it("uses the browser's own modelContext when one exists", () => {
    const provideContext = vi.fn();
    (navigator as any).modelContext = { provideContext };

    const { mode, count } = registerCanvasTools(api);

    expect(mode).toBe("native");
    expect(provideContext).toHaveBeenCalledTimes(1);
    expect(provideContext.mock.calls[0][0].tools).toHaveLength(count);
  });

  /**
   * What Chrome 152 actually implements.
   *
   * Not what the explainer describes, and the difference is the whole bug this
   * suite exists for: the API is `document.modelContext`, and it has no
   * `provideContext` — tools go up one at a time through
   * `registerTool(tool, { signal })` and come down by aborting that signal.
   * Reading `navigator.modelContext` and calling `provideContext` on it, the
   * page was a WebMCP provider to nobody but itself, on every origin, in a
   * browser that supported it perfectly well.
   */
  describe("the platform API as Chrome ships it", () => {
    /** Stands in for `document.modelContext`: registerTool only, no batch. */
    const nativeChrome = () => {
      const tools: any[] = [];
      const registerTool = vi.fn(
        (tool: any, options?: { signal?: AbortSignal }) => {
          if (tools.some((existing) => existing.name === tool.name)) {
            throw new DOMException(
              `duplicate ${tool.name}`,
              "InvalidStateError",
            );
          }
          tools.push(tool);
          options?.signal?.addEventListener("abort", () => {
            const at = tools.indexOf(tool);
            if (at >= 0) {
              tools.splice(at, 1);
            }
          });
          return Promise.resolve();
        },
      );
      return { registerTool, tools };
    };

    it("registers with document.modelContext, not just navigator", () => {
      const native = nativeChrome();
      (document as any).modelContext = native;

      const { mode, count } = registerCanvasTools(api);

      expect(mode).toBe("native");
      expect(count).toBe(TOOL_DECLARATIONS.length);
      expect(native.tools.map((t) => t.name).sort()).toEqual(
        TOOL_DECLARATIONS.map((t) => t.name).sort(),
      );
    });

    it("prefers the document over a stale navigator implementation", () => {
      const onDocument = nativeChrome();
      const onNavigator = nativeChrome();
      (document as any).modelContext = onDocument;
      (navigator as any).modelContext = onNavigator;

      registerCanvasTools(api);

      expect(onDocument.tools).toHaveLength(TOOL_DECLARATIONS.length);
      expect(onNavigator.tools).toHaveLength(0);
    });

    it("declares tools in the shape Chrome validates", () => {
      const native = nativeChrome();
      (document as any).modelContext = native;

      registerCanvasTools(api);

      // Chrome rejects a declaration whose inputSchema is not an object type,
      // whose `properties` is not an object, or whose `required` is not an
      // array — and a rejected declaration is a tool no agent can call.
      expect(native.tools).toHaveLength(TOOL_DECLARATIONS.length);
      for (const tool of native.tools) {
        expect(typeof tool.name).toBe("string");
        expect(typeof tool.description).toBe("string");
        expect(tool.inputSchema.type).toBe("object");
        expect(typeof tool.inputSchema.properties).toBe("object");
        expect(Array.isArray(tool.inputSchema.required)).toBe(true);
        expect(typeof tool.execute).toBe("function");
      }
    });

    it("withdraws by aborting the signal, so a remount is not a duplicate", () => {
      const native = nativeChrome();
      (document as any).modelContext = native;

      // The editor remounting re-registers the same eight names. Chrome throws
      // InvalidStateError on a duplicate and there is no unregisterTool to
      // call, so the signal is the only way back out.
      registerCanvasTools(api);
      expect(() => registerCanvasTools(api)).not.toThrow();

      expect(native.tools).toHaveLength(TOOL_DECLARATIONS.length);
      expect(native.tools.map((t) => t.name)).toHaveLength(
        new Set(native.tools.map((t) => t.name)).size,
      );

      unregisterCanvasTools();
      expect(native.tools).toHaveLength(0);
    });

    it("runs a real canvas edit through the tool Chrome was handed", async () => {
      const native = nativeChrome();
      (document as any).modelContext = native;
      registerCanvasTools(api);

      // Exactly what the browser's agent would hold: the declaration object
      // Chrome received, invoked without going near our own code.
      const addShape = native.tools.find((t) => t.name === "add_shape")!;
      const result = await addShape.execute({
        x: 60,
        y: 60,
        width: 180,
        height: 80,
        label: "From Chrome",
      });

      expect(result.isError).toBeFalsy();
      expect(get_scene(api)[0]).toMatchObject({ label: "From Chrome" });
    });

    it("does not shadow the attribute when the platform defines it empty", () => {
      // Chrome exposes the attribute; it just reads empty at this instant. An
      // own property of ours would hide the real one for the life of the page.
      Object.defineProperty(document, "modelContext", {
        configurable: true,
        get: () => undefined,
      });

      registerCanvasTools(api);

      expect(
        Object.getOwnPropertyDescriptor(document, "modelContext")?.get?.(),
      ).toBeUndefined();
      expect(getProviderMode()).toBe("shim");
    });
  });

  /**
   * The shim is a fallback, not a verdict.
   *
   * `navigator.modelContext` does not always exist by the time the editor
   * mounts — a browser can expose it late, and an extension's content script
   * is often injected only when the user activates it, long after. The old
   * code answered that by assigning its shim over the property and deciding
   * the mode once. Two things then went wrong at once: an injector guarding on
   * `if (!navigator.modelContext)` found ours and never installed, so no
   * external agent could reach the canvas; and the badge said "shim" for the
   * rest of the session whatever happened afterwards.
   */
  describe("handing over to a native implementation that arrives late", () => {
    it("adopts one assigned after the editor has already registered", () => {
      registerCanvasTools(api);
      expect(getProviderMode()).toBe("shim");

      const provideContext = vi.fn();
      (navigator as any).modelContext = { provideContext };

      expect(getProviderMode()).toBe("native");
      expect(provideContext).toHaveBeenCalledTimes(1);
      expect(provideContext.mock.calls[0][0].tools).toHaveLength(
        TOOL_DECLARATIONS.length,
      );
    });

    it("does not leave its shim in the way of the assignment", () => {
      registerCanvasTools(api);

      const native = { provideContext: vi.fn() };
      (navigator as any).modelContext = native;

      // Reading it back has to give the real implementation, or an injector
      // that checks its own work concludes the install failed.
      expect((navigator as any).modelContext).toBe(native);
    });

    it("tells the UI, so the badge stops claiming shim", () => {
      const seen: string[] = [];
      const unsubscribe = subscribeProvider(({ mode }) => seen.push(mode));

      registerCanvasTools(api);
      (navigator as any).modelContext = { provideContext: vi.fn() };
      unsubscribe();

      expect(seen).toContain("shim");
      expect(seen[seen.length - 1]).toBe("native");
    });

    it("adopts one that appears on document after the editor registered", () => {
      vi.useFakeTimers();
      try {
        registerCanvasTools(api);
        expect(getProviderMode()).toBe("shim");

        const registerTool = vi.fn(() => Promise.resolve());
        (document as any).modelContext = { registerTool };

        vi.advanceTimersByTime(1000);

        expect(getProviderMode()).toBe("native");
        expect(registerTool).toHaveBeenCalledTimes(TOOL_DECLARATIONS.length);
      } finally {
        vi.useRealTimers();
      }
    });

    it("notices one installed with defineProperty rather than assignment", () => {
      vi.useFakeTimers();
      try {
        registerCanvasTools(api);

        // Redefining the property bypasses our setter entirely, so the only
        // way to find out is to look again.
        const provideContext = vi.fn();
        Object.defineProperty(navigator, "modelContext", {
          configurable: true,
          value: { provideContext },
        });
        expect(getProviderMode()).toBe("shim");

        vi.advanceTimersByTime(1000);

        expect(getProviderMode()).toBe("native");
        expect(provideContext).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("runs a tool through the WebMCP surface and changes the canvas", async () => {
    registerCanvasTools(api);

    const outcome = await callTool("add_shape", {
      x: 200,
      y: 120,
      width: 180,
      height: 80,
      label: "Database",
    });

    expect(outcome.ok).toBe(true);
    const scene = get_scene(api);
    expect(scene).toHaveLength(1);
    expect(scene[0]).toMatchObject({ label: "Database", x: 200, y: 120 });
  });

  it("still runs a tool after a hot reload empties the module's cache", async () => {
    // Register through the module instance the app is using.
    registerCanvasTools(api);

    // A dev hot reload re-evaluates the module: its cache of registered tools
    // starts empty again, while the provider object on `navigator` — and so
    // the real registry — survives untouched. Before this was handled, every
    // call in the session failed with "declared but not registered yet" until
    // the page was reloaded by hand.
    vi.resetModules();
    const reloaded = await import("../ai-agent/webmcp/provider");

    expect(reloaded.getRegisteredTools()).toHaveLength(0);

    const outcome = await reloaded.callTool("add_shape", {
      x: 40,
      y: 40,
      width: 180,
      height: 80,
      label: "Survived",
    });

    expect(outcome).toMatchObject({ ok: true });
    expect(get_scene(api)).toHaveLength(1);
    expect(get_scene(api)[0]).toMatchObject({ label: "Survived" });
  });

  it("reports an unregistered tool honestly once the provider is really gone", async () => {
    registerCanvasTools(api);
    unregisterCanvasTools();

    const outcome = await callTool("remove_element", { id: "anything" });

    expect(outcome).toMatchObject({
      ok: false,
      error: expect.stringContaining("not registered"),
    });
  });

  it("returns content blocks, not raw values", async () => {
    registerCanvasTools(api);
    const tool = getRegisteredTools().find((t) => t.name === "get_scene")!;

    const result = await tool.execute({});

    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content[0].type).toBe("text");
    expect(typeof result.content[0].text).toBe("string");
  });

  it("reports a failing tool as isError instead of rejecting", async () => {
    registerCanvasTools(api);
    const tool = getRegisteredTools().find((t) => t.name === "remove_element")!;

    // An agent has to be able to read the failure and try something else; a
    // rejected promise would abort its turn instead.
    const result = await tool.execute({ id: "nope" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/does not exist/);
  });

  it("refuses a tool it never declared", async () => {
    registerCanvasTools(api);
    const outcome = await callTool("drop_database", {});

    expect(outcome).toEqual({
      ok: false,
      error: 'Unknown tool "drop_database".',
    });
  });

  it("re-registering replaces the previous set rather than duplicating", () => {
    registerCanvasTools(api);
    registerCanvasTools(api);

    const names = getRegisteredTools().map((tool) => tool.name);
    expect(names).toHaveLength(new Set(names).size);
    expect(names).toHaveLength(TOOL_DECLARATIONS.length);
  });

  it("withdraws its tools on unregister", () => {
    registerCanvasTools(api);
    unregisterCanvasTools();
    expect(getRegisteredTools()).toEqual([]);
  });

  it("exports the same tools to the model as it declares to agents", () => {
    // The backend is handed this list, so the two must not drift apart.
    const forModel = toolsForModel();

    expect(forModel.map((t) => t.name).sort()).toEqual(
      TOOL_DECLARATIONS.map((t) => t.name).sort(),
    );
    for (const tool of forModel) {
      expect(tool).toHaveProperty("input_schema");
      expect(tool).not.toHaveProperty("inputSchema");
    }
  });
});
