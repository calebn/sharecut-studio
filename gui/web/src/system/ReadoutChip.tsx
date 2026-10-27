import type { CSSProperties } from "react";

export type ReadoutChipProps = {
  /** The change since the drag began, already formatted: "−120 ms". */
  delta?: string;
  /** The resulting value, already formatted: "12:04.340". */
  value: string;
  /** The drag has reached the end of what it may do. */
  atLimit?: boolean;
  /** The pointer, in px from the top left of the positioned parent. Without it the chip sits in the flow. */
  at?: { readonly x: number; readonly y: number };
};

/** Announced by the control being dragged, so the chip stays out of the accessibility tree. */
export function ReadoutChip({ delta, value, atLimit, at }: ReadoutChipProps) {
  return (
    <output
      className="sys-readout"
      aria-hidden="true"
      data-limit={atLimit || undefined}
      data-floating={at ? "true" : undefined}
      style={
        at
          ? ({
              "--sys-readout-x": `${at.x}px`,
              "--sys-readout-y": `${at.y}px`,
            } as CSSProperties)
          : undefined
      }
    >
      {delta ? <span className="sys-readout-delta">{delta}</span> : null}
      <span className="sys-readout-value">{value}</span>
      {atLimit ? <span className="sys-readout-limit">limit</span> : null}
    </output>
  );
}
