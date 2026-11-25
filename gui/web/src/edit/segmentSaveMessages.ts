import {
  type SegmentSaveRefusal,
  type SegmentSaveResult,
  segmentSaveRefusal,
} from "../api";

const REFUSALS: Record<SegmentSaveRefusal, string> = {
  segment_clip_too_short:
    "A clip in this selection is too short to save. Move the edge of the range, or pick whole clips.",
  segment_render_unsupported:
    "This selection has filled gaps, muted speakers or restored original audio, which a segment cannot keep. Pick audio without them.",
  segment_busy:
    "Your library is busy with another save. Try again in a moment.",
  segment_write_failed:
    "Your library could not be written to. Check that there is room on the disk, then try again.",
  segment_invalid:
    "That selection cannot be saved as a segment. Pick a different clip or range.",
};

export const SAVE_FAILED = "That did not save. Try again.";

export function segmentSaveMessage(error: unknown): string {
  const refusal = segmentSaveRefusal(error);
  return refusal ? REFUSALS[refusal] : SAVE_FAILED;
}

export function segmentSavedMessage(
  name: string,
  result: SegmentSaveResult,
): string {
  if (result.status === "unchanged")
    return `${name} is already in your library`;
  if (result.status === "new_version")
    return `Saved ${name} as version ${result.version}`;
  return `Saved ${name} to your library`;
}
