export type BleedAttenuationSpan = Readonly<{ start: number; end: number }>;

export type BleedAttenuationKind = "late_gate" | "bleed_mute:off_speaker";

export type BleedAttenuationRegion<TTarget> = Readonly<{
  trackId: string;
  occurrenceId: string;
  kind: BleedAttenuationKind;
  sourceSpan: BleedAttenuationSpan;
  timelineSpan: BleedAttenuationSpan;
  restore:
    | { state: "available"; target: TTarget; sourceSpan: BleedAttenuationSpan }
    | { state: "saved" }
    | { state: "unavailable"; reason: string };
}>;

export type BleedAttenuationInspection<TTarget> = Readonly<{
  clipLabel: string;
  planState: "disabled" | "ready" | "unavailable_evidence";
  planReasons: readonly string[];
  artifactState: "missing" | "stale" | "current";
  restoreState: "none" | "current" | "changed_content" | "unverified";
  savedSourceSpans: readonly BleedAttenuationSpan[];
  regions: readonly BleedAttenuationRegion<TTarget>[];
}>;

export const BLEED_ATTENUATION_LABELS: Record<BleedAttenuationKind, string> = {
  late_gate: "Automatic reduction",
  "bleed_mute:off_speaker": "Automatic speaker mute",
};

export function bleedAttenuationSpanLabel(span: BleedAttenuationSpan): string {
  return `${span.start.toFixed(3)} to ${span.end.toFixed(3)} s`;
}

export function bleedAttenuationRegionKey<TTarget>(
  region: BleedAttenuationRegion<TTarget>,
): string {
  return JSON.stringify([
    region.trackId,
    region.occurrenceId,
    region.kind,
    region.sourceSpan.start,
    region.sourceSpan.end,
    region.timelineSpan.start,
    region.timelineSpan.end,
  ]);
}

export function bleedAttenuationRegionLabel<TTarget>(
  region: BleedAttenuationRegion<TTarget>,
): string {
  return `${BLEED_ATTENUATION_LABELS[region.kind]}, timeline ${bleedAttenuationSpanLabel(region.timelineSpan)}, source ${bleedAttenuationSpanLabel(region.sourceSpan)}`;
}
