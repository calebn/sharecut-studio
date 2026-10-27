import type { PointerEvent } from "react";
import { clamp } from "../utils/math";

export function pointerRatio(track: HTMLElement | null, clientX: number) {
  const rect = track?.getBoundingClientRect();
  return clamp((clientX - (rect?.left ?? 0)) / (rect?.width || 1), 0, 1);
}

export function capturePointer(event: PointerEvent<HTMLElement>) {
  try {
    event.currentTarget.setPointerCapture(event.pointerId);
  } catch {
    // A synthetic pointer has nothing to capture.
  }
}
