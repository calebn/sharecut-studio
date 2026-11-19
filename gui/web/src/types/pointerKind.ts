/**
 * Last-used pointing device kind: fine (mouse/pen) vs coarse (touch).
 * Tracked live from Pointer Events; drives input-mode adaptation (e.g. the
 * presence `mobile_mode` payload), never presence visibility.
 */
export type PointerKind = "fine" | "coarse";
