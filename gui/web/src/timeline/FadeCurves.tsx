/**
 * A clip's fades over its waveform (#677): straight gain ramps, the shape
 * render plays (ffmpeg afade / acrossfade `tri`), with the attenuated side
 * dimmed. Paint only; the handles live in ClipBlockView.
 */

import { fadeCurvePaths, fadeCurveViewBox } from "./fadeCurvePaths";

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
        viewBox={fadeCurveViewBox(widthPx)}
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
