import { memo } from "react";
import { bucketPeaks } from "./peakBuckets";

export const PeakStrip = memo(function PeakStrip({
  peaks,
  maxBars,
}: {
  peaks: readonly number[];
  /** Folds the peaks to at most this many bars; leave out to draw every peak. */
  maxBars?: number;
}) {
  const drawn = maxBars === undefined ? peaks : bucketPeaks(peaks, maxBars);
  return (
    <svg
      viewBox={`0 0 ${Math.max(drawn.length, 1)} 1`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      {drawn.map((peak, index) => {
        const x = index + 0.15;
        return (
          <rect
            key={x}
            className="sys-wave-peak"
            x={x}
            y={(1 - peak) / 2}
            width={0.7}
            height={Math.max(peak, 0.04)}
          />
        );
      })}
    </svg>
  );
});
