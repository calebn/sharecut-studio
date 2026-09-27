import type { Ref } from "react";

interface PlayheadNeedleProps {
  /** Lane-stack px, or `"100%"` inside the ruler. */
  height: number | string;
  xPx: number;
  ref?: Ref<HTMLDivElement>;
}

/** Prop-only production paint shared by the live timeline and Storybook. */
export function PlayheadNeedle({ height, xPx, ref }: PlayheadNeedleProps) {
  return (
    <div
      ref={ref}
      className="playhead"
      style={{ height, transform: `translateX(${xPx}px)` }}
      aria-hidden="true"
    />
  );
}
