import type { ClipMuteRegion } from "../types/project";

/**
 * Mutes that overlap [srcStart, srcEnd), whole: a copy cut through a mute stays
 * silent up to the cut and fades only at the mute's own edges. Mirrors
 * `mute_regions_overlapping` in `edits/mute_regions.py`.
 */
export function muteRegionsOverlapping(
  regions: ClipMuteRegion[] | undefined,
  srcStart: number,
  srcEnd: number,
): ClipMuteRegion[] {
  return (regions ?? []).filter(
    (region) =>
      region.end_s > srcStart + 1e-9 && region.start_s < srcEnd - 1e-9,
  );
}
