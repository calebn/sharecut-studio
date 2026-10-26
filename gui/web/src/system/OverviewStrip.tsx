export type OverviewTick = {
  /** 0 to 1 across the episode. */
  at: number;
  kind: "suggestion" | "comment" | "find" | "chapter" | "session";
  current?: boolean;
};

export type OverviewStripProps = {
  /** 16 phone Edit, 32 Review, 48 Project card (static), 64 expanded Player. */
  height: 16 | 32 | 48 | 64;
  /** Peak heights, 0 to 1. A flat line when empty. */
  peaks?: readonly number[];
  playhead?: number;
  viewport?: readonly [number, number];
  selection?: readonly [number, number];
  ticks?: readonly OverviewTick[];
  label: string;
};

/**
 * A whole-episode miniature. Static: seeking is wired where it is used.
 * Comments are dots, every other tick is a line.
 */
export function OverviewStrip({
  height,
  peaks = [],
  playhead,
  viewport,
  selection,
  ticks = [],
  label,
}: OverviewStripProps) {
  const count = Math.max(peaks.length, 1);
  const lines = ticks.filter((tick) => tick.kind !== "comment");
  const dots = ticks.filter((tick) => tick.kind === "comment");
  return (
    <div
      className={`sys-overview sys-overview--${height}`}
      role="img"
      aria-label={label}
    >
      <svg
        viewBox={`0 0 ${count} 1`}
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        {selection ? (
          <rect
            className="sys-overview-selection"
            x={selection[0] * count}
            y={0}
            width={(selection[1] - selection[0]) * count}
            height={1}
          />
        ) : null}
        {peaks.length === 0 ? (
          <rect
            className="sys-overview-peak"
            x={0}
            y={0.48}
            width={1}
            height={0.04}
          />
        ) : (
          peaks.map((peak, index) => (
            <rect
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed order
              key={index}
              className="sys-overview-peak"
              x={index + 0.15}
              y={(1 - peak) / 2}
              width={0.7}
              height={Math.max(peak, 0.04)}
            />
          ))
        )}
        {lines.map((tick) => (
          <line
            key={`${tick.kind}-${tick.at}-${tick.current ? "now" : ""}`}
            className={`sys-overview-tick sys-overview-tick--${tick.kind}${tick.current ? " is-current" : ""}`}
            x1={tick.at * count}
            x2={tick.at * count}
            y1={0}
            y2={1}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      {dots.map((tick) => (
        <span
          key={`${tick.kind}-${tick.at}-${tick.current ? "now" : ""}`}
          className={`sys-overview-dot${tick.current ? " is-current" : ""}`}
          style={{ insetInlineStart: `${tick.at * 100}%` }}
        />
      ))}
      {viewport ? (
        <span
          className="sys-overview-viewport"
          style={{
            insetInlineStart: `${viewport[0] * 100}%`,
            inlineSize: `${(viewport[1] - viewport[0]) * 100}%`,
          }}
        />
      ) : null}
      {playhead === undefined ? null : (
        <span
          className="sys-overview-playhead"
          style={{ insetInlineStart: `${playhead * 100}%` }}
        />
      )}
    </div>
  );
}
