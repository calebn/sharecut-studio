import type { PointerKind } from "../types/pointerKind";

export const PRIMARY_FINE_QUERY = "(pointer: fine)";
export const ANY_COARSE_QUERY = "(any-pointer: coarse)";

/**
 * Initial input kind from capability queries, so the value is correct on
 * first paint — before any pointer event has been observed. A primary fine
 * pointer wins on hybrid devices; otherwise any coarse pointer is enough to
 * choose coarse. Falls back to "fine" outside a browser (SSR/tests without
 * matchMedia).
 */
export function initialPointerKind(): PointerKind {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return "fine";
  }
  if (window.matchMedia(PRIMARY_FINE_QUERY).matches) {
    return "fine";
  }
  return window.matchMedia(ANY_COARSE_QUERY).matches ? "coarse" : "fine";
}
