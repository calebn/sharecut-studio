import type { DuckingPlan } from "../api";
import { ApiError, refusalReason } from "../utils/apiError";

/**
 * What a ducking dry run says about the saved dips. Pure so the inspector row,
 * the palette command and their tests read one rule.
 *
 * - `ready`: the plan would write dips and no earlier run left any
 * - `stale`: an earlier run left dips and the plan would replace them, as a cut
 *   or move does (a ripple moves speech but not the saved dips)
 * - `current`: the saved dips already match the plan
 */
export type DuckingKind = "ready" | "stale" | "current";

export function duckingKind(plan: DuckingPlan): DuckingKind {
  const changed = plan.tracks.filter((t) => t.changed);
  if (changed.length === 0) return "current";
  return changed.some((t) => t.replacedEarlierDips > 0) ? "stale" : "ready";
}

export function duckingTrackCount(plan: DuckingPlan): number {
  return plan.tracks.filter((t) => t.changed).length;
}

const tracksOf = (count: number) =>
  count === 1 ? "1 music track" : `${count} music tracks`;

const dbOf = (depthDb: number) =>
  `${Math.abs(Math.round(depthDb * 10) / 10)} dB`;

export const DUCKING_NO_MUSIC =
  "There is no music to lower: none is added, or every music track is muted or silent. Add or unmute one.";
export const DUCKING_NO_SPEECH =
  "There is no transcribed speech to lower music under yet. Transcribe the episode first.";
export const DUCKING_CURRENT = "Music already follows the speech.";
export const DUCKING_STALE = "Ducking may be out of date. Duck again.";
export const DUCKING_CHECKING = "Checking your music tracks...";
export const DUCKING_UNREACHABLE =
  "Could not check the music tracks. You can still duck.";
export const DUCKING_CHANGED = "The episode changed. Check again.";
export const DUCKING_LABEL = "Duck music under speech";
export const DUCKING_AGAIN_LABEL = "Duck again";

/** The line under the row for a plan that would write dips. */
export function duckingReadyLine(plan: DuckingPlan): string {
  return `Lowers ${tracksOf(duckingTrackCount(plan))} by ${dbOf(plan.depthDb)} while people speak. Your own volume points above the dip are lowered during speech, never raised, and restored when you duck again.`;
}

/** The toast after dips were saved. Stems are not re-rendered by this edit. */
export function duckingAppliedLine(plan: DuckingPlan): string {
  return `Music now lowers under speech on ${tracksOf(duckingTrackCount(plan))}. Hear it once the mix refreshes, in play or export.`;
}

/** The refusal codes whose cause is the episode's state, not a failure. */
export type DuckingRefusal = "none" | "silent" | "changed";

export function duckingRefusal(error: unknown): DuckingRefusal | null {
  if (!(error instanceof ApiError)) return null;
  if (error.code === "ducking_no_targets") return "none";
  if (error.code === "ducking_no_dialogue_activity") return "silent";
  if (error.status === 409) return "changed";
  return null;
}

/**
 * The host's own words for a refusal that is not a state of the episode (too
 * many points, an unknown or dialogue track): the host answered, so the
 * connection is fine and ducking would be refused again. Null for a failure
 * to reach the host, which leaves the host free to try.
 */
export function duckingRefusedMessage(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === null || error.status >= 500) return null;
  return refusalReason(error);
}

export function duckingRefusalLine(refusal: DuckingRefusal): string {
  if (refusal === "none") return DUCKING_NO_MUSIC;
  if (refusal === "silent") return DUCKING_NO_SPEECH;
  return DUCKING_CHANGED;
}
