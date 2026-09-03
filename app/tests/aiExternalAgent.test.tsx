import { resolvablePromise } from "@excalidraw/common";
import { Excalidraw } from "@excalidraw/excalidraw";
import { render } from "@excalidraw/excalidraw/tests/test-utils";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { get_scene } from "../ai-agent/toolLayer";
import { registerCanvasTools } from "../ai-agent/webmcp/provider";

/**
 * Stands in for a third-party agent.
 *
 * The point of WebMCP is that something which knows nothing about this app can
 * still drive it. So everything below reaches the canvas ONLY through the
 * page's model context — no toolLayer import, no excalidrawAPI, no knowledge
 * that Excalidraw is involved at all. It discovers what it can do by reading
 * the manifest, the same way a browser agent would.
 *
 * `get_scene` is used to verify the outcome, and is deliberately the only
 * privileged import here.
 */

type DiscoveredTool = {
  name: string;
  description: string;
  inputSchema: any;
  execute: (params: unknown) => Promise<{
    content: { type: string; text: string }[];
    isError?: boolean;
  }>;
};

/** Everything the page has declared to the browser. */
const discoverTools = (): DiscoveredTool[] => {
  // Chrome puts it on the document; the older draft and the polyfills put it
  // on the navigator. An agent that only knew one of those would have called
  // this page toolless.
  const context =
    (document as any).modelContext ?? (navigator as any).modelContext;
  if (!context) {
    throw new Error("This page is not a WebMCP tool provider.");
  }
  // With a native implementation the browser brokers discovery; with the shim
  // there is no browser in the middle, so it exposes the manifest directly.
  // Either way the agent works from the declaration, never from our source.
  const tools = context.__tools ?? context.getTools?.() ?? [];
  return tools as DiscoveredTool[];
};

const invoke = async (
  tools: DiscoveredTool[],
  name: string,
  params: unknown,
) => {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`No tool named "${name}" is available on this page.`);
  }
  const result = await tool.execute(params);
  if (result.isError) {
    throw new Error(result.content.map((part) => part.text).join("\n"));
  }
  return result.content.map((part) => part.text).join("\n");
};

describe("a third-party agent driving the canvas", () => {
  let api: ExcalidrawImperativeAPI;

  beforeEach(async () => {
    delete (navigator as any).modelContext;
    delete (document as any).modelContext;
    const p = resolvablePromise<ExcalidrawImperativeAPI>();
    await render(<Excalidraw onExcalidrawAPI={(a) => p.resolve(a as any)} />);
    api = await p;
    registerCanvasTools(api);
  });

  it("discovers what the page can do without being told", () => {
    const tools = discoverTools();

    expect(tools.length).toBeGreaterThan(0);
    // It learns the vocabulary from the manifest, not from our source.
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("create_diagram");
    expect(names).toContain("get_scene");

    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("reads the canvas through the manifest alone", async () => {
    const tools = discoverTools();
    const before = await invoke(tools, "get_scene", {});
    expect(JSON.parse(before)).toEqual([]);
  });

  it("builds a whole diagram knowing nothing about Excalidraw", async () => {
    const tools = discoverTools();

    await invoke(tools, "create_diagram", {
      nodes: [
        { key: "client", label: "Client" },
        { key: "api", label: "API" },
        { key: "db", label: "Database" },
      ],
      edges: [
        { from: "client", to: "api" },
        { from: "api", to: "db" },
      ],
    });

    // verified from the app's side: the canvas really changed
    const scene = get_scene(api);
    const boxes = scene.filter((el) => el.type !== "arrow");
    expect(boxes.map((b) => b.label).sort()).toEqual([
      "API",
      "Client",
      "Database",
    ]);
    expect(scene.filter((el) => el.type === "arrow")).toHaveLength(2);
  });

  it("edits what it previously drew, using ids it read back", async () => {
    const tools = discoverTools();

    await invoke(tools, "create_diagram", {
      nodes: [{ key: "cache", label: "Cache" }],
      edges: [],
    });

    // It has no handle on the element — it has to go back through get_scene,
    // which is exactly what a real agent would do.
    const scene = JSON.parse(await invoke(tools, "get_scene", {}));
    const cache = scene.find((el: any) => el.label === "Cache");
    expect(cache).toBeDefined();

    await invoke(tools, "set_style", {
      ids: [cache.id],
      backgroundColor: "#a5d8ff",
    });

    expect(get_scene(api).find((el) => el.id === cache.id)).toMatchObject({
      backgroundColor: "#a5d8ff",
    });
  });

  it("is told plainly when it asks for something impossible", async () => {
    const tools = discoverTools();

    await expect(
      invoke(tools, "remove_element", { id: "not-a-real-id" }),
    ).rejects.toThrow(/does not exist/);

    // and the page is unharmed
    expect(get_scene(api)).toEqual([]);
  });
});
