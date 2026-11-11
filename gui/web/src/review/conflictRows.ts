import type { OfflineConflict } from "../services/offlineQueue/offlineStore";
import { DocumentCommand } from "../types/documentCommands.generated";
import { formatTimeShort } from "../utils/time";

const STALE_RANGE_CODE = "range_changed";

/** A guest cut that no longer fits a newer host edit, in words for its Status row. */
export type ConflictSuggestion = {
  title: string;
  /** Accessible names that start with the visible label, each saying which cut. */
  names: { hear: string; suggestAgain: string; drop: string };
  /** The span the cut covered, in timeline seconds. */
  startSec: number;
  endSec: number;
  trackIds: readonly string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export function cutSpan(payload: unknown) {
  if (!isRecord(payload) || payload.action !== "cut") return undefined;
  if (!Array.isArray(payload.targets)) return undefined;
  let startSec = Number.POSITIVE_INFINITY;
  let endSec = Number.NEGATIVE_INFINITY;
  const trackIds = new Set<string>();
  for (const target of payload.targets) {
    if (!isRecord(target) || !Array.isArray(target.intervals)) continue;
    for (const interval of target.intervals) {
      if (!isRecord(interval)) continue;
      const { start, end } = interval;
      if (
        typeof start !== "number" ||
        typeof end !== "number" ||
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        end < start
      ) {
        continue;
      }
      startSec = Math.min(startSec, start);
      endSec = Math.max(endSec, end);
      if (Array.isArray(target.track_ids)) {
        for (const id of target.track_ids) {
          if (typeof id === "string") trackIds.add(id);
        }
      }
    }
  }
  return Number.isFinite(startSec)
    ? { startSec, endSec, trackIds: [...trackIds] }
    : undefined;
}

/**
 * The suggestion behind a refused guest cut, or undefined for any other outcome. Only a
 * range cut the server called stale qualifies: a mute is not "your cut", and a refusal
 * without a stale code keeps the generic row.
 */
export function suggestionOf(
  conflict: OfflineConflict,
): ConflictSuggestion | undefined {
  if (
    conflict.kind !== "refused" ||
    conflict.code !== STALE_RANGE_CODE ||
    conflict.command.type !== DocumentCommand.EditSelectedRange
  ) {
    return undefined;
  }
  const span = cutSpan(conflict.command.payload);
  if (!span) return undefined;
  const at = formatTimeShort(span.startSec);
  return {
    title: `Your cut at ${at} overlaps a newer edit`,
    names: {
      hear: `Hear your cut at ${at}`,
      suggestAgain: `Suggest again here, your cut at ${at}`,
      drop: `Drop it, your cut at ${at}`,
    },
    ...span,
  };
}
