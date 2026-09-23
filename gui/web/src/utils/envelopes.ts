import type { AutomationEnvelope, AutomationPoint } from "../types/project";

export const ENVELOPE_VALUE_MAX = 1.5;

export function clampEnvelopeValue(value: number): number {
  return Math.max(0, Math.min(ENVELOPE_VALUE_MAX, value));
}

export function findVolumeEnvelope(
  envelopes: AutomationEnvelope[] | undefined,
  trackId: string,
): AutomationEnvelope | undefined {
  return envelopes?.find(
    (e) =>
      e.track_id === trackId &&
      (e.parameter === "volume" || e.parameter === "gain" || !e.parameter),
  );
}

export function sortedVolumePoints(
  envelopes: AutomationEnvelope[] | undefined,
  trackId: string,
): AutomationPoint[] {
  const env = findVolumeEnvelope(envelopes, trackId);
  if (!env) {
    return [];
  }
  return [...env.points].sort((a, b) => a.time - b.time);
}

/** Positions closer than this are the same point (drag jitter, float noise). */
export const ENVELOPE_POINT_EPSILON = 1e-6;

/** Same identity and position; the one "point unchanged" rule for drag and inspector. */
export function sameEnvelopePoint(
  a: AutomationPoint,
  b: AutomationPoint,
): boolean {
  return (
    a.id === b.id &&
    Math.abs(a.time - b.time) <= ENVELOPE_POINT_EPSILON &&
    Math.abs(a.value - b.value) <= ENVELOPE_POINT_EPSILON
  );
}

/** Replace a track's volume points, leaving other parameters (e.g. pan) alone. */
export function withVolumeEnvelopePoints(
  envelopes: AutomationEnvelope[],
  trackId: string,
  points: AutomationPoint[],
): AutomationEnvelope[] {
  const current = findVolumeEnvelope(envelopes, trackId);
  if (!current) {
    return [...envelopes, { track_id: trackId, parameter: "volume", points }];
  }
  return envelopes.map((e) => (e === current ? { ...e, points } : e));
}

export function replaceEnvelopePoint(
  points: AutomationPoint[],
  index: number,
  next: AutomationPoint,
): { points: AutomationPoint[]; index: number } {
  const tagged = points.map((p, i) => ({ ...p, i }));
  tagged[index] = { ...next, i: index };
  tagged.sort((a, b) => a.time - b.time);
  return {
    points: tagged.map(({ id, time, value }) => ({ id, time, value })),
    index: tagged.findIndex((p) => p.i === index),
  };
}

export function indexOfVolumePointAtTime(
  envelopes: AutomationEnvelope[] | undefined,
  trackId: string,
  time: number,
): number {
  const points = sortedVolumePoints(envelopes, trackId);
  if (points.length === 0) {
    return -1;
  }
  let best = 0;
  let bestDist = Math.abs(points[0]!.time - time);
  for (let i = 1; i < points.length; i++) {
    const dist = Math.abs(points[i]!.time - time);
    if (dist < bestDist) {
      best = i;
      bestDist = dist;
    }
  }
  return best;
}
