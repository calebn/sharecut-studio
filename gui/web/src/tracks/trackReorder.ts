/** Fallback MIME — Safari/Chrome are unreliable with custom types during dragover. */
export const TRACK_REORDER_TEXT_MIME = "text/plain";

/** Private MIME so track-header DnD does not collide with audio file drops. */
export const TRACK_REORDER_MIME = "application/x-sharecut-track-id";

export function setTrackReorderData(dt: DataTransfer, trackId: string): void {
  dt.setData(TRACK_REORDER_TEXT_MIME, trackId);
  try {
    dt.setData(TRACK_REORDER_MIME, trackId);
  } catch {
    // Some browsers reject custom MIME types.
  }
  dt.effectAllowed = "move";
}

export function readTrackReorderId(dt: DataTransfer): string | null {
  const custom = dt.getData(TRACK_REORDER_MIME).trim();
  if (custom) {
    return custom;
  }
  const plain = dt.getData(TRACK_REORDER_TEXT_MIME).trim();
  return plain || null;
}

/**
 * True when types suggest a track reorder (may be empty during dragover in
 * some browsers — prefer an in-app dragActive flag for allowing drops).
 */
export function isTrackReorderDrag(dt: DataTransfer): boolean {
  const types = Array.from(dt.types);
  return (
    types.includes(TRACK_REORDER_MIME) ||
    types.includes(TRACK_REORDER_TEXT_MIME) ||
    types.includes("Text")
  );
}

/**
 * Insert index after removing ``sourceIndex``, given a drop on ``targetIndex``
 * (before = top half, after = bottom half).
 */
export function reorderInsertIndex(
  sourceIndex: number,
  targetIndex: number,
  placeAfter: boolean,
): number {
  let dest = targetIndex + (placeAfter ? 1 : 0);
  if (sourceIndex < dest) {
    dest -= 1;
  }
  return Math.max(0, dest);
}
