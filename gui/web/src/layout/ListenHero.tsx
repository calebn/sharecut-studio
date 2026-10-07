import { type ReactNode, useId } from "react";

type Props = {
  /** Project name; the phone Listen screen's visible heading. */
  title: string;
  playing?: boolean;
  /** Play / Pause and Stop controls (command-wired in the app). */
  controls: ReactNode;
  /** Timecode readout. */
  timecode: ReactNode;
  /** Range input that seeks the playhead. */
  scrubber: ReactNode;
  /** Skip-back button, left of Play. */
  skipBack?: ReactNode;
  /** Skip-forward button, right of Play. */
  skipForward?: ReactNode;
  /** The app Menu trigger, beside the title (Listen has no transport bar). */
  menu?: ReactNode;
};

/**
 * Phone Listen hero: the transport's dark strip as a card. Title and Menu,
 * timecode, a full-width scrubber, then one centered controls row: skip back,
 * Play and Stop, skip forward.
 */
export function ListenHero({
  title,
  playing = false,
  controls,
  timecode,
  scrubber,
  skipBack,
  skipForward,
  menu,
}: Props) {
  const titleId = useId();
  return (
    <section
      className="listen-hero"
      data-playing={playing}
      aria-labelledby={titleId}
    >
      <div className="listen-hero-head">
        <h1 id={titleId} className="listen-hero-title">
          {title}
        </h1>
        {menu}
      </div>
      <div className="listen-hero-time">{timecode}</div>
      {scrubber}
      <div className="listen-hero-controls">
        <div className="listen-hero-skip">{skipBack}</div>
        <div className="listen-hero-transport">{controls}</div>
        <div className="listen-hero-skip">{skipForward}</div>
      </div>
    </section>
  );
}
