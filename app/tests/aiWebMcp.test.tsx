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
    const p = resolvablePromise<ExcalidrawImperativeAPI>();
    await render(<Excalidraw onExcalidrawAPI={(a) => p.resolve(a as any)} />);
    api = await p;
  });

  afterEach(() => {
    unregisterCanvasTools();
    delete (navigator as any).modelContext;
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

  it("runs a tool through the WebMCP surface and changes the canvas", async () => {
    registerCanvasTools(api);

    const outcome = await callTool("add_rectangle", {
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
