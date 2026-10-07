/**
 * How far a ripple trim will move a clip (#1135, trim mode Option A): an
 * arrow from where it starts now to where it will start. The clips stay put
 * while the drag previews and slide there when it lands.
 */
import type { CSSProperties } from "react";

/** An arrow along a lane from x `from` to x `to` (css px, lane-relative). */
export function RippleArrow({ from, to }: { from: number; to: number }) {
  const left = Math.min(from, to);
  const width = Math.abs(to - from);
  if (width < 1) return null;
  const toLeft = to < from;
  return (
    <svg
      className="ripple-arrow"
      style={{ left, width } as CSSProperties}
      viewBox={`0 0 ${width} 12`}
      preserveAspectRatio="none"
      aria-hidden="true"
      focusable="false"
    >
      <path d={`M0 6H${width}`} />
      <path d={toLeft ? "M6 1 1 6l5 5" : `M${width - 6} 1l5 5-5 5`} />
    </svg>
  );
}
