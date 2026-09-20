/** Stop / skip-edge epsilon (seconds) shared by host and guest transport. */
export const AUDITION_STOP_EPS_SEC = 0.02;

/** If playhead is in [skipStart, skipEnd), jump to skipEnd. */
export function nextPlayheadAfterSkip(
  t: number,
  skipStart: number | null,
  skipEnd: number | null,
): number {
  if (skipStart == null || skipEnd == null || skipEnd <= skipStart) {
    return t;
  }
  if (t >= skipStart - AUDITION_STOP_EPS_SEC && t < skipEnd) {
    return skipEnd;
  }
  return t;
}
