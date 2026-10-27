/** Captures the pointer for dragging. Fails for pointers that are already gone, which is harmless. */
export function capturePointer(e: PointerEvent) {
  try {
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  } catch {
    /* no active pointer */
  }
}
