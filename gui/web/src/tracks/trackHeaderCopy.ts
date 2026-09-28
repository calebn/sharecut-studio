import { displayShortcutFor } from "../keymap/registry";
import type { TrackView } from "../types/project";
import { formatGainDb } from "../utils/audio";

/** Stem status text, used as both the chip prefix and the icon's title. */
export const STEM_STATUS_LABEL: Record<"fresh" | "stale", string> = {
  fresh: "Stem up to date",
  stale: "Stem out of date",
};

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Role and speaker, each shown only when it differs from the track name and
 * from the other value already shown, so nothing repeats the name itself.
 */
export function trackSubtitle(track: TrackView): string {
  const label = (track.label || track.id).trim();
  const parts: string[] = [];
  const role = track.role?.trim();
  if (role && !sameName(role, label)) {
    parts.push(role);
  }
  const speaker = track.speaker?.trim();
  if (
    speaker &&
    !sameName(speaker, label) &&
    !parts.some((p) => sameName(p, speaker))
  ) {
    parts.push(speaker);
  }
  return parts.join(" · ");
}

/** Tooltip for the track-reorder handle: names both the drag and key paths. */
export function reorderHandleTitle(): string {
  const up = displayShortcutFor("track.moveUp");
  const down = displayShortcutFor("track.moveDown");
  const keys = up && down ? `${up} / ${down}` : "↑ / ↓";
  return `Drag to reorder, or select the track and press ${keys}`;
}

/** Tooltip for the "Out" readout: what plays, and where to change it. */
export function outputGainTitle(
  out: number,
  staging: number,
  volume: number,
): string {
  return `Plays at ${formatGainDb(out)}: staging ${formatGainDb(staging)}, volume ${formatGainDb(volume)}. Change the volume in the track details`;
}
