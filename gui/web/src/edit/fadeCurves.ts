import type { ClipRow, FadeCurve } from "../types/project";

/** The edge shapes the server takes, in the order the picker lists them. */
export const FADE_CURVES: readonly FadeCurve[] = ["linear", "equal_power", "s"];

export type FadeEdge = "in" | "out";

/** Curves a SetClipFade names; a curve left out keeps the saved one. */
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

/** The button tooltip: the name, and for Equal power what it is not. */
export function fadeCurveTitle(curve: FadeCurve): string {
  return curve === "equal_power"
    ? "Quarter sine; a true equal-power pair needs a crossfade"
    : CURVE_LABEL[curve];
}

export function isFadeCurve(value: unknown): value is FadeCurve {
  return FADE_CURVES.some((curve) => curve === value);
}

/** The curve a clip's edge plays, a missing one being linear. */
export function clipEdgeCurve(clip: ClipRow, edge: FadeEdge): FadeCurve {
  return (edge === "in" ? clip.fade_in_curve : clip.fade_out_curve) ?? "linear";
}

/** The non-linear curves of a clip, for a copy: the server refuses an unknown shape and omits linear. */
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

/** The curves in a command payload that are valid shapes; anything else is left out. */
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
