import { useCallback, useEffect, useState } from "react";

const DEFAULT_SIDEBAR_WIDTH = 302; // matches RIGHT_SIDEBAR_WIDTH upstream
const MIN_SIDEBAR_WIDTH = 280;
const MAX_SIDEBAR_WIDTH = 900;
const WIDTH_STORAGE_KEY = "ai-agent:sidebar-width";
const WIDTH_STYLE_ID = "ai-agent-sidebar-width";

const clampWidth = (value: number) =>
  Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(value)));

/**
 * Makes the docked sidebar horizontally resizable.
 *
 * Upstream sets `--right-sidebar-width` as an inline style on the .excalidraw
 * container, and the editor also uses that variable to reserve canvas space —
 * so overriding it resizes the panel and reflows the canvas together. We write
 * the override as a stylesheet rule with !important rather than touching the
 * element's style, because React owns that inline style and would clobber us on
 * the next render.
 */
export const useResizableSidebar = () => {
  const [width, setWidth] = useState<number>(() => {
    try {
      const stored = Number(localStorage.getItem(WIDTH_STORAGE_KEY));
      return stored ? clampWidth(stored) : DEFAULT_SIDEBAR_WIDTH;
    } catch {
      return DEFAULT_SIDEBAR_WIDTH;
    }
  });

  useEffect(() => {
    let style = document.getElementById(
      WIDTH_STYLE_ID,
    ) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = WIDTH_STYLE_ID;
      document.head.appendChild(style);
    }
    style.textContent = `.excalidraw { --right-sidebar-width: ${width}px !important; }`;

    try {
      localStorage.setItem(WIDTH_STORAGE_KEY, String(width));
    } catch {
      // a browser with site data blocked still resizes, it just will not persist
    }
  }, [width]);

  // Drag right-to-left to widen, since the panel is anchored to the right edge.
  const onResizeStart = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = width;
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);

      const onMove = (moveEvent: PointerEvent) => {
        setWidth(clampWidth(startWidth - (moveEvent.clientX - startX)));
      };
      const onUp = () => {
        handle.releasePointerCapture(event.pointerId);
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
      };

      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
    },
    [width],
  );

  const resetWidth = useCallback(() => setWidth(DEFAULT_SIDEBAR_WIDTH), []);

  return { onResizeStart, resetWidth };
};
