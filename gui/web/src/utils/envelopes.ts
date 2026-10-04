import type { AutomationEnvelope, AutomationPoint } from "../types/project";

export const ENVELOPE_VALUE_MAX = 1.5;

export function clampEnvelopeValue(value: number): number {
  return Math.max(0, Math.min(ENVELOPE_VALUE_MAX, value));
}

export function findVolumeEnvelope(
  envelopes: readonly AutomationEnvelope[] | undefined,
  trackId: string,
): AutomationEnvelope | undefined {
  return envelopes?.find(
    (e) => e.track_id === trackId && e.parameter === "volume",
  );
}

export function sortedVolumePoints(
  envelopes: readonly AutomationEnvelope[] | undefined,
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
  points: readonly AutomationPoint[],
  next: AutomationPoint,
): AutomationPoint[] {
  return points
    .map((point) => (point.id === next.id ? next : point))
    .sort((a, b) => a.time - b.time);
}

export function envelopeValueAt(
  points: readonly AutomationPoint[],
  time: number,
): number {
  if (points.length === 0) return 1;
  const sorted = [...points].sort((a, b) => a.time - b.time);
  if (time < sorted[0]!.time) return sorted[0]!.value;
  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i]!;
    if (time < next.time) {
      const previous = sorted[i - 1]!;
      return (
        previous.value +
        ((next.value - previous.value) * (time - previous.time)) /
          (next.time - previous.time)
      );
    }
  }
  return sorted[sorted.length - 1]!.value;
}

export function sameEnvelopePoints(
  a: readonly AutomationPoint[],
  b: readonly AutomationPoint[],
): boolean {
  return (
    a.length === b.length &&
    a.every((point, index) => {
      const other = b[index];
      return (
        other != null &&
        point.id === other.id &&
        point.time === other.time &&
        point.value === other.value
      );
    })
  );
}
