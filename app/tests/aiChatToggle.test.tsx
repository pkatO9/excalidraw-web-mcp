import { Excalidraw, ExcalidrawAPIProvider } from "@excalidraw/excalidraw";
import { render } from "@excalidraw/excalidraw/tests/test-utils";

import { AIChatToggle } from "../ai-agent/ChatSidebar";

describe("AIChatToggle", () => {
  it("renders a compact 'AI' button once the editor API is available", async () => {
    const { container } = await render(
      <ExcalidrawAPIProvider>
        <Excalidraw />
        <AIChatToggle />
      </ExcalidrawAPIProvider>,
    );

    const button = container.querySelector<HTMLButtonElement>(
      "button.ai-chat__toggle",
    );

    expect(button).not.toBeNull();
    expect(button!.textContent).toBe("AI");
    // it is a plain in-flow button now, not a floating overlay
    expect(button!.className).not.toMatch(/fixed/);
  });
});
