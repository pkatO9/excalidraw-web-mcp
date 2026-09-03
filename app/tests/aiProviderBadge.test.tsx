import { fireEvent, render, screen } from "@testing-library/react";

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
