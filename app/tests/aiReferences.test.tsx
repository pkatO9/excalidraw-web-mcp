import { resolvablePromise } from "@excalidraw/common";
import { Excalidraw } from "@excalidraw/excalidraw";
import { act, render } from "@excalidraw/excalidraw/tests/test-utils";
import { fireEvent } from "@testing-library/react";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { AIChatSidebar, AI_SIDEBAR_NAME } from "../ai-agent/ChatSidebar";
import { add_rectangle } from "../ai-agent/toolLayer";

describe("canvas selection becomes a chat reference", () => {
  let api: ExcalidrawImperativeAPI;
  let container: HTMLElement;

  beforeEach(async () => {
    const apiPromise = resolvablePromise<ExcalidrawImperativeAPI>();
    // <Sidebar> reads the editor's appState context, so it must live inside
    // <Excalidraw> exactly as it does in the app.
    const rendered = await render(
      <Excalidraw
        onExcalidrawAPI={(a) => apiPromise.resolve(a as any)}
        initialData={{
          appState: { openSidebar: { name: AI_SIDEBAR_NAME } },
        }}
      >
        <AIChatSidebar />
      </Excalidraw>,
    );
    container = rendered.container;
    api = await apiPromise;
  });

  const select = async (...ids: string[]) => {
    await act(async () => {
      api.updateScene({
        appState: {
          selectedElementIds: Object.fromEntries(
            ids.map((id) => [id, true] as const),
          ),
        },
      });
    });
  };

  const pills = () =>
    Array.from(container.querySelectorAll(".ai-chat__ref-label")).map(
      (el) => el.textContent,
    );

  it("shows no pills until something is selected", () => {
    expect(pills()).toEqual([]);
  });

  it("shows a pill labelled with the selected shape's text", async () => {
    const box = add_rectangle(api, {
      x: 0,
      y: 0,
      width: 180,
      height: 80,
      label: "Database",
    });

    await select(box.id);

    expect(pills()).toEqual(["Database"]);
  });

  it("shows one pill per selected element", async () => {
    const a = add_rectangle(api, {
      x: 0,
      y: 0,
      width: 180,
      height: 80,
      label: "Load Balancer",
    });
    const b = add_rectangle(api, {
      x: 400,
      y: 0,
      width: 180,
      height: 80,
      label: "Database",
    });

    await select(a.id, b.id);

    expect(pills().sort()).toEqual(["Database", "Load Balancer"]);
  });

  it("drops a pill when dismissed, and restores it on reselect", async () => {
    const box = add_rectangle(api, {
      x: 0,
      y: 0,
      width: 180,
      height: 80,
      label: "Cache",
    });

    await select(box.id);
    expect(pills()).toEqual(["Cache"]);

    await act(async () => {
      fireEvent.click(container.querySelector(".ai-chat__ref-remove")!);
    });
    expect(pills()).toEqual([]);

    // deselecting and reselecting brings the reference back
    await select();
    await select(box.id);
    expect(pills()).toEqual(["Cache"]);
  });

  it("collapses a big selection behind a +N chip, and expands on click", async () => {
    const ids = Array.from({ length: 10 }, (_, i) =>
      add_rectangle(api, {
        x: i * 400,
        y: 0,
        width: 180,
        height: 80,
        label: `Box ${i}`,
      }),
    ).map((box) => box.id);

    await select(...ids);

    // only the first few are drawn, the rest hide behind the chip
    expect(pills()).toHaveLength(4);
    const more = container.querySelector<HTMLButtonElement>(
      ".ai-chat__ref--more",
    );
    expect(more).not.toBeNull();
    expect(more!.textContent).toBe("+6");

    // ...but the container still reports the full selection, which is what is
    // actually sent with the message
    expect(
      container.querySelector(".ai-chat__refs")!.getAttribute("aria-label"),
    ).toBe("10 referenced element(s)");

    await act(async () => {
      fireEvent.click(more!);
    });

    expect(pills()).toHaveLength(10);
    expect(container.querySelector(".ai-chat__ref--more")!.textContent).toBe(
      "Show less",
    );
  });

  it("shows no +N chip when the selection already fits", async () => {
    const ids = Array.from({ length: 3 }, (_, i) =>
      add_rectangle(api, {
        x: i * 400,
        y: 0,
        width: 180,
        height: 80,
        label: `Box ${i}`,
      }),
    ).map((box) => box.id);

    await select(...ids);

    expect(pills()).toHaveLength(3);
    expect(container.querySelector(".ai-chat__ref--more")).toBeNull();
  });

  it("clears pills when the canvas selection is cleared", async () => {
    const box = add_rectangle(api, {
      x: 0,
      y: 0,
      width: 180,
      height: 80,
      label: "Queue",
    });

    await select(box.id);
    expect(pills()).toEqual(["Queue"]);

    await select();
    expect(pills()).toEqual([]);
  });
});
