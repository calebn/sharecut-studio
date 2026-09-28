/**
 * A clip's fades over its waveform (#677): straight gain ramps, the shape
 * render plays (ffmpeg afade / acrossfade `tri`), with the attenuated side
 * dimmed. Paint only; the handles live in ClipBlock.
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

export function FadeCurves({
  widthPx,
  inPx,
  outPx,
}: {
  widthPx: number;
  inPx: number;
  outPx: number;
}) {
  const { dim, lines } = fadeCurvePaths(widthPx, inPx, outPx);
  if (lines.length === 0) {
    return null;
  }
  return (
    <span className="clip-fade-curves" aria-hidden="true">
      <svg
        viewBox={`0 0 ${r2(Math.max(1, widthPx))} 100`}
        preserveAspectRatio="none"
        focusable="false"
      >
        {dim.map((d) => (
          <path key={d} className="clip-fade-dim" d={d} />
        ))}
        {lines.map((d) => (
          <path key={d} className="clip-fade-line" d={d} />
        ))}
      </svg>
    </span>
  );
}
