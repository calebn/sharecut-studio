type Props = {
  /** Playhead time, already formatted (`00:12.345`). */
  current: string;
  /** Session duration, already formatted; omitted in compact chrome. */
  total?: string;
  /** Full `current / total` pair for the tooltip. */
  title?: string;
  className?: string;
};

/** Tabular timecode readout: large current time, muted total. */
export function Timecode({ current, total, title, className }: Props) {
  const classes = className ? `timecode ${className}` : "timecode";
  return (
    <span className={classes} title={title}>
      <span className="timecode-current">{current}</span>
      {total ? <span className="timecode-total">{` / ${total}`}</span> : null}
    </span>
  );
}
