import { resolvablePromise } from "@excalidraw/common";
import { Excalidraw } from "@excalidraw/excalidraw";
import { render as renderEditor } from "@excalidraw/excalidraw/tests/test-utils";
import { fireEvent, render, screen } from "@testing-library/react";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { AIChatSidebar, AI_SIDEBAR_NAME } from "../ai-agent/ChatSidebar";
import { ProviderBadge } from "../ai-agent/ProviderBadge";
import { TOOL_DECLARATIONS } from "../ai-agent/webmcp/descriptors";

/**
 * The badge is the only place the app tells you, without devtools, what it has
 * declared to the browser. It says the mode; opening it says which tools — so
 * the claim on the header can be checked rather than taken on trust.
 */
describe("the WebMCP badge", () => {
  it("reports the mode and the count without being opened", () => {
    render(<ProviderBadge mode="native" count={8} />);

    const badge = screen.getByRole("button", { expanded: false });
    expect(badge.textContent).toContain("WebMCP · native · 8 tools");
  });

  it("opens onto every tool the page declares", () => {
    render(<ProviderBadge mode="native" count={8} />);

    fireEvent.click(screen.getByRole("button"));

    const panel = screen.getByRole("dialog");
    for (const tool of TOOL_DECLARATIONS) {
      expect(panel.textContent).toContain(tool.name);
    }
  });

  it("shows what a call takes, required parameters marked", () => {
    render(<ProviderBadge mode="native" count={8} />);
    fireEvent.click(screen.getByRole("button"));

    // bind_arrow takes two ids and both are required — the chips are the only
    // hint of a call's shape, so they have to be the schema's own truth.
    const required = [
      ...screen
        .getByRole("dialog")
        .querySelectorAll(".ai-chat__tool-param--required"),
    ].map((chip) => chip.textContent);

    expect(required).toContain("source_id");
    expect(required).toContain("target_id");
    // add_shape's colours are optional, and an agent should not think otherwise
    expect(required).not.toContain("backgroundColor");
  });

  it("is honest about the shim rather than implying a browser agent can call in", () => {
    render(<ProviderBadge mode="shim" count={8} />);
    fireEvent.click(screen.getByRole("button"));

    expect(screen.getByRole("dialog").textContent).toMatch(/only this page/i);
  });

  it("closes on Escape without taking the sidebar with it", () => {
    const onKeyDown = vi.fn();
    render(
      <div onKeyDown={onKeyDown}>
        <ProviderBadge mode="native" count={8} />
      </div>,
    );
    fireEvent.click(screen.getByRole("button"));

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
    // The editor closes the whole sidebar on Escape. Losing the panel when you
    // meant to dismiss a popover inside it would be a bad trade.
    expect(onKeyDown).not.toHaveBeenCalled();
  });

  it("closes when you click away from it", () => {
    render(<ProviderBadge mode="native" count={8} />);
    fireEvent.click(screen.getByRole("button"));

    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

/**
 * The header's layout is CSS, which these cannot see. What they can hold is the
 * structure that CSS depends on: brand and badge inside one wrapper that owns
 * the wrapping, and the popover anchored to the sidebar header rather than to
 * that wrapper — .sidebar__header is the full width of the panel and is the
 * only positioned ancestor, so a popover parented anywhere else would be laid
 * out against a box that is only as wide as the badge.
 */
describe("the header at a narrow sidebar", () => {
  let container: HTMLElement;

  beforeEach(async () => {
    const apiPromise = resolvablePromise<ExcalidrawImperativeAPI>();
    const rendered = await renderEditor(
      <Excalidraw
        onExcalidrawAPI={(a) => apiPromise.resolve(a as any)}
        initialData={{ appState: { openSidebar: { name: AI_SIDEBAR_NAME } } }}
      >
        <AIChatSidebar />
      </Excalidraw>,
    );
    container = rendered.container;
    await apiPromise;
  });

  it("keeps the brand and the badge in one wrapper that can wrap", () => {
    const header = container.querySelector(".ai-chat__header")!;

    expect(header).not.toBeNull();
    expect(header.querySelector(".ai-chat__brand")).not.toBeNull();
    expect(header.querySelector(".ai-chat__webmcp")).not.toBeNull();
  });

  it("hangs the tool popover off the sidebar header, not the wrapper", () => {
    fireEvent.click(container.querySelector("button.ai-chat__webmcp")!);

    const popover = container.querySelector(".ai-chat__tools")!;
    expect(popover).not.toBeNull();
    // Its offset parent at runtime is .sidebar__header; in the DOM that means
    // no positioned element may sit between them.
    expect(popover.closest(".sidebar__header")).not.toBeNull();
  });
});
