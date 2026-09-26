/** A handle drag shorter than this (CSS px) is a click: select, never commit. */
export const HANDLE_DRAG_MIN_PX = 3;

/** True when a handle moved far enough between pointerdown and pointerup to be an edit. */
export function isHandleDrag(originX: number, clientX: number): boolean {
  return Math.abs(clientX - originX) >= HANDLE_DRAG_MIN_PX;
}
