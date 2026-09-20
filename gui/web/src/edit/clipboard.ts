/**
 * Session clipboard for structural copy/cut/paste (same-track, time-only paste).
 * Not the OS clipboard — Correct-mode text fields keep native copy/paste.
 */

/** Relative clip extract captured at copy/cut time (survives ripple-delete). */
export type ClipboardExtract = {
  track_id: string;
  source_start: number;
  source_end: number;
  /** Offset within the copied span (0 = start of range). */
  relative_timeline_start: number;
  source_id?: string | null;
  fade_in_ms?: number;
  fade_out_ms?: number;
  join_in_mode?: string;
  mute_regions?: { start_s: number; end_s: number }[];
};

export type ClipboardPayload = {
  timelineStart: number;
  timelineEnd: number;
  mode: "copy" | "cut";
  /** When set, only these tracks; omit/empty = all dialogue in range (backend default). */
  trackIds?: string[];
  /** Plain text of selected words (optional external convenience). */
  plainText?: string;
  /** Clip extracts for paste after cut (and robust copy paste). */
  extracts: ClipboardExtract[];
};

let payload: ClipboardPayload | null = null;

export function getClipboard(): ClipboardPayload | null {
  return payload;
}

export function setClipboard(next: ClipboardPayload | null): void {
  if (
    next != null &&
    !(
      Number.isFinite(next.timelineStart) &&
      Number.isFinite(next.timelineEnd) &&
      next.timelineEnd > next.timelineStart &&
      (next.mode === "copy" || next.mode === "cut")
    )
  ) {
    payload = null;
    return;
  }
  payload = next;
}

export function clearClipboard(): void {
  payload = null;
}

/** Test helper. */
export function _resetClipboardForTests(): void {
  payload = null;
}
