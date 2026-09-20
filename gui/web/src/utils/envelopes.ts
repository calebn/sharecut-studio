import type { AutomationEnvelope } from "../types/project";

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
): { time: number; value: number }[] {
  const env = findVolumeEnvelope(envelopes, trackId);
  if (!env) {
    return [];
  }
  return [...env.points].sort((a, b) => a.time - b.time);
}

export function replaceEnvelopePoint(
  points: { time: number; value: number }[],
  index: number,
  next: { time: number; value: number },
): { points: { time: number; value: number }[]; index: number } {
  const tagged = points.map((p, i) => ({ ...p, i }));
  tagged[index] = { ...next, i: index };
  tagged.sort((a, b) => a.time - b.time);
  return {
    points: tagged.map(({ time, value }) => ({ time, value })),
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
