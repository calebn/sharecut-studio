import type { ReactNode, Ref } from "react";

type FrameProps = {
  ref?: Ref<HTMLElement>;
  /** Tablet/phone chrome. */
  compact?: boolean;
  /** Labeled chrome folded into the menu; zones flatten into one row. */
  collapsed?: boolean;
  /** Drives the live-state light on Play and the timecode. */
  playing?: boolean;
  children: ReactNode;
};

/**
 * Fixed dark transport strip. Wide layout is three zones (project, centered
 * playback, status and tools); collapsed layout flattens them into one row.
 */
export function TransportFrame({
  ref,
  compact = false,
  collapsed = false,
  playing = false,
  children,
}: FrameProps) {
  const classes = [
    "transport",
    compact ? "transport--compact" : "",
    collapsed ? "transport--collapsed" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <header ref={ref} data-playing={playing} className={classes}>
      {children}
    </header>
  );
}

type ZoneProps = {
  position: "start" | "center" | "end";
  children: ReactNode;
};

export function TransportZone({ position, children }: ZoneProps) {
  return (
    <div className={`transport-zone transport-zone--${position}`}>
      {children}
    </div>
  );
}
