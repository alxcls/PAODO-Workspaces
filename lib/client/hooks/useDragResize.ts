import { useCallback, useEffect, useRef } from "react";

type ResizeCursor = "col-resize" | "row-resize";

interface UseDragResizeOptions {
  /**
   * Called on every mousemove while a drag is active. Compute the new size (or ratio) here from the
   * event and your own container bounds, then set state. Kept caller-side on purpose so each site's
   * distinct geometry — which edge, pixels vs. ratio, clamp bounds — stays legible at its use site.
   */
  onMove: (e: MouseEvent) => void;
  /** Body cursor shown for the duration of the drag. Defaults to horizontal (column) resize. */
  cursor?: ResizeCursor;
  /**
   * Notified when a drag starts (true) and ends (false). Wire it to an `isDragging` state to, e.g.,
   * overlay a pointer-events shield so an iframe/CodeMirror doesn't swallow the mouse mid-drag.
   */
  onDragChange?: (dragging: boolean) => void;
}

/**
 * Owns the identical mouse-drag boilerplate every resizable divider needs — the window
 * mousemove/mouseup listeners, the dragging guard, the body cursor/user-select toggle, and cleanup —
 * so pages don't hand-copy it. Returns a `startDrag` to bind to the divider's `onMouseDown`; the
 * per-site geometry lives in `onMove`.
 */
export function useDragResize({ onMove, cursor = "col-resize", onDragChange }: UseDragResizeOptions): () => void {
  const dragging = useRef(false);
  // Keep the latest callbacks in refs so passing inline closures doesn't re-subscribe the window
  // listeners on every render (the listeners are registered once, on mount). Written in an effect,
  // not during render — effects run long before any mouse event reads them.
  const onMoveRef = useRef(onMove);
  const onDragChangeRef = useRef(onDragChange);
  useEffect(() => {
    onMoveRef.current = onMove;
    onDragChangeRef.current = onDragChange;
  });

  useEffect(() => {
    const move = (e: MouseEvent) => { if (dragging.current) onMoveRef.current(e); };
    const up = () => {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      onDragChangeRef.current?.(false);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, []);

  return useCallback(() => {
    dragging.current = true;
    document.body.style.cursor = cursor;
    document.body.style.userSelect = "none";
    onDragChangeRef.current?.(true);
  }, [cursor]);
}
