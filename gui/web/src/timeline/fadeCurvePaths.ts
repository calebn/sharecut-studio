/**
 * Path math for a clip's fade ramps (#677). It lives outside FadeCurves.tsx so
 * that module exports only components (react-refresh/only-export-components).
 */

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Path data in a `widthPx × 100` viewBox (y 0 = full gain, at the top). */
export function fadeCurvePaths(
  widthPx: number,
  inPx: number,
  outPx: number,
): { dim: string[]; lines: string[] } {
  const w = r2(Math.max(0, widthPx));
  const i = r2(Math.min(Math.max(0, inPx), w));
  const o = r2(Math.min(Math.max(0, outPx), w));
  const dim: string[] = [];
  const lines: string[] = [];
  if (i > 0) {
    dim.push(`M0 0H${i}L0 100Z`);
    lines.push(`M0 100L${i} 0`);
  }
  if (o > 0) {
    dim.push(`M${r2(w - o)} 0H${w}V100Z`);
    lines.push(`M${r2(w - o)} 0L${w} 100`);
  }
  return { dim, lines };
}

/** The `widthPx × 100` viewBox the paths are drawn in (at least 1 px wide). */
export function fadeCurveViewBox(widthPx: number): string {
  return `0 0 ${r2(Math.max(1, widthPx))} 100`;
}
