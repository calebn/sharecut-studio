import type { ClipRow, FadeCurve } from "../types/project";

export const FADE_CURVES: readonly FadeCurve[] = ["linear", "equal_power", "s"];

export type FadeEdge = "in" | "out";

export type ClipFadeCurves = Readonly<{
  fade_in_curve?: FadeCurve;
  fade_out_curve?: FadeCurve;
}>;

const CURVE_LABEL: Record<FadeCurve, string> = {
  linear: "Linear",
  equal_power: "Equal power",
  s: "S",
};

export function fadeCurveLabel(curve: FadeCurve): string {
  return CURVE_LABEL[curve];
}

export function fadeCurveTitle(curve: FadeCurve): string {
  return curve === "equal_power"
    ? "Quarter sine; a true equal-power pair needs a crossfade"
    : CURVE_LABEL[curve];
}

export function isFadeCurve(value: unknown): value is FadeCurve {
  return FADE_CURVES.some((curve) => curve === value);
}

export function clipEdgeCurve(clip: ClipRow, edge: FadeEdge): FadeCurve {
  return (edge === "in" ? clip.fade_in_curve : clip.fade_out_curve) ?? "linear";
}

export function clipFadeCurves(clip: ClipRow): ClipFadeCurves {
  const shaped = (curve: unknown) =>
    isFadeCurve(curve) && curve !== "linear" ? curve : undefined;
  const fade_in_curve = shaped(clip.fade_in_curve);
  const fade_out_curve = shaped(clip.fade_out_curve);
  return {
    ...(fade_in_curve ? { fade_in_curve } : {}),
    ...(fade_out_curve ? { fade_out_curve } : {}),
  };
}

export function payloadFadeCurves(
  payload: Record<string, unknown>,
): ClipFadeCurves {
  return {
    ...(isFadeCurve(payload.fade_in_curve)
      ? { fade_in_curve: payload.fade_in_curve }
      : {}),
    ...(isFadeCurve(payload.fade_out_curve)
      ? { fade_out_curve: payload.fade_out_curve }
      : {}),
  };
}
