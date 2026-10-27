export function PeakStrip({ peaks }: { peaks: readonly number[] }) {
  return (
    <svg
      viewBox={`0 0 ${Math.max(peaks.length, 1)} 1`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      {peaks.map((peak, index) => {
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
}
