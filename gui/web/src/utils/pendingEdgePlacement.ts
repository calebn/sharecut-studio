import type { ClipRow } from "../types/project";
import { sourceSecInClipToTimeline } from "./timebase";

export const ENDPOINT_EPSILON_SEC = 1e-5;

export type PendingEdgePlacement =
  | { kind: "identity" }
  | { kind: "clip"; clip: ClipRow };

/** Match the unique real placement that projects a stored source endpoint. */
export function pendingEdgePlacement(
  clips: readonly ClipRow[],
  sourceSec: number,
  timelineSec: number,
): PendingEdgePlacement | null {
  if (clips.length === 0) {
    return { kind: "identity" };
  }
  const matches = clips.filter((clip) => {
    if (
      sourceSec < clip.source_start - ENDPOINT_EPSILON_SEC ||
      sourceSec > clip.source_end + ENDPOINT_EPSILON_SEC
    ) {
      return false;
    }
    const projected = sourceSecInClipToTimeline(clip, sourceSec);
    return (
      projected != null &&
      Math.abs(projected - timelineSec) <= ENDPOINT_EPSILON_SEC
    );
  });
  return matches.length === 1 ? { kind: "clip", clip: matches[0] } : null;
}
