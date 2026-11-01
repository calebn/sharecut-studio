import type { EnvelopeChange, HitAttrs } from "../system/Envelope";
import {
  dbToGain,
  type EnvelopePointData,
  gainToDb,
  sameLevelDb,
} from "../system/envelopeMath";
import type { AutomationPoint, Selection } from "../types/project";
import { ENVELOPE_POINT_EPSILON } from "../utils/envelopes";
import type { HitTargetAttrs } from "./hitTargets";

/** A nudge in progress: the point's time and level as the keys have moved them, not yet saved. */
export type PointPreview = { id: string; time: number; db: number };

/** The points whose time and level are numbers: the only ones the lane draws, as points, line or dips. */
export function finitePoints(
  points: readonly AutomationPoint[],
): AutomationPoint[] {
  return points.filter(
    (p) => Number.isFinite(p.time) && Number.isFinite(p.value),
  );
}

/** The lane speaks dB; the store speaks gain. A point whose time or level is not a number is left out. */
export function toLeafPoints(
  points: readonly AutomationPoint[],
): EnvelopePointData[] {
  return finitePoints(points).map((p) => ({
    id: p.id,
    time: p.time,
    db: gainToDb(p.value),
  }));
}

export function selectedPointId(
  selection: Selection,
  trackId: string,
): string | null {
  return selection?.kind === "envelopePoint" && selection.trackId === trackId
    ? selection.pointId
    : null;
}

/** `points` with the previewed point's time and level replaced. */
export function withPreview(
  points: readonly EnvelopePointData[],
  preview: PointPreview,
): EnvelopePointData[] {
  return points.map((p) =>
    p.id === preview.id ? { ...p, time: preview.time, db: preview.db } : p,
  );
}

/**
 * What to save for a gesture's result against the point as stored: only an
 * axis that changed (time by more than the point epsilon, level by more than
 * the stored dB resolution), so a time drag never rewrites the level and the
 * reverse. Null: nothing to save.
 */
export function editFor(
  change: EnvelopeChange,
  stored: AutomationPoint,
): { time?: number; value?: number } | null {
  const time =
    change.timeSeconds !== undefined &&
    Math.abs(change.timeSeconds - stored.time) > ENVELOPE_POINT_EPSILON
      ? change.timeSeconds
      : undefined;
  const value =
    change.db !== undefined && !sameLevelDb(change.db, gainToDb(stored.value))
      ? dbToGain(change.db)
      : undefined;
  return time === undefined && value === undefined
    ? null
    : {
        ...(time !== undefined ? { time } : {}),
        ...(value !== undefined ? { value } : {}),
      };
}

/** The hit attributes the leaf accepts: `HitTargetAttrs` without its absent optionals. */
export function toHitAttrs(attrs: HitTargetAttrs): HitAttrs {
  return Object.fromEntries(
    Object.entries(attrs).filter(([, v]) => v !== undefined),
  ) as HitAttrs;
}
