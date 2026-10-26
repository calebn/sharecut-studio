import { type CSSProperties, useId } from "react";
import { presenceColorVar } from "../presence/colors";
import { Button, Pill } from "../ui";
import { OverviewStrip, type OverviewTick } from "./OverviewStrip";
import { SystemIcon } from "./SystemIcon";
import { VerbButton } from "./VerbButton";

export type PlayerChapter = { title: string; time: string; at: number };

export type PlayerProps = {
  form: "bar" | "expanded";
  playing: boolean;
  time: string;
  total: string;
  /** Edited-length delta, e.g. `−4:10`. */
  cuts?: string;
  /** Mix is re-rendering: a ring on Play and a Status pill. */
  state?: "ready" | "loading" | "mix-updating" | "error";
  hearOriginal?: boolean;
  solo?: string;
  following?: { name: string; colorIndex: number };
  /** Drops A/B and the mix pills (Guest Review). */
  guest?: boolean;
  title?: string;
  chapters?: readonly PlayerChapter[];
  chapter?: number;
  peaks?: readonly number[];
  ticks?: readonly OverviewTick[];
  playhead?: number;
  onPlayPause: () => void;
  onSkip?: (seconds: number) => void;
  /** Toggles here; the press-and-hold gesture and the held A key are wired with the app (#2292). */
  onHearOriginal?: (on: boolean) => void;
  onComment?: () => void;
  onExpand?: () => void;
  onCollapse?: () => void;
  onRetry?: () => void;
};

const SKIP = 15;

function Skip({
  seconds,
  onSkip,
}: {
  seconds: number;
  onSkip?: (seconds: number) => void;
}) {
  const back = seconds < 0;
  return (
    <button
      type="button"
      className="sys-icon-btn sys-player-skip"
      aria-label={`${back ? "Back" : "Forward"} ${SKIP} seconds`}
      title={`${back ? "Back" : "Forward"} ${SKIP} seconds`}
      onClick={() => onSkip?.(seconds)}
    >
      <span aria-hidden="true">
        {back ? "−" : "+"}
        {SKIP}
      </span>
    </button>
  );
}

function Play({ playing, state, following, onPlayPause }: PlayerProps) {
  const style = following
    ? ({
        "--sys-follow": presenceColorVar(following.colorIndex),
      } as CSSProperties)
    : undefined;
  return (
    <span
      className="sys-play"
      style={style}
      data-following={following ? "" : undefined}
    >
      <VerbButton
        verb="play"
        alt={playing}
        label={playing ? "Pause" : "Play"}
        className="sys-play-btn"
        size={20}
        onClick={onPlayPause}
        aria-busy={state === "loading" ? true : undefined}
      />
      {state === "loading" ? (
        <SystemIcon
          name="progress-ring"
          size={48}
          progress={0.3}
          className="sys-play-ring"
        />
      ) : null}
    </span>
  );
}

function StatePills(props: PlayerProps) {
  const { cuts, solo, state, guest } = props;
  return (
    <>
      {cuts ? (
        <Pill title="Length change from your cuts">
          <span className="sys-mono">{cuts}</span>
        </Pill>
      ) : null}
      {solo && !guest ? (
        <Pill className="sys-player-extra">
          <SystemIcon name="headphones" size={12} /> {solo}
        </Pill>
      ) : null}
      {state === "mix-updating" ? (
        <Pill className="sys-player-extra">
          <SystemIcon name="progress-ring" size={12} progress={0.3} /> Updating
          mix
        </Pill>
      ) : null}
      {state === "error" ? (
        <Pill tone="warning">
          <SystemIcon name="octagon-alert" size={12} /> Audio error
        </Pill>
      ) : null}
    </>
  );
}

function HearOriginal({ hearOriginal, onHearOriginal }: PlayerProps) {
  return (
    <button
      type="button"
      className="sys-icon-btn sys-player-ab"
      aria-pressed={hearOriginal ?? false}
      aria-label="Hear the original"
      title="Hear the original (A)"
      onClick={() => onHearOriginal?.(!hearOriginal)}
    >
      <span aria-hidden="true">A/B</span>
    </button>
  );
}

/** The Player in its 56 px bar form and its expanded form. Props only. */
export function Player(props: PlayerProps) {
  const headingId = useId();
  const {
    form,
    time,
    total,
    state,
    following,
    guest,
    title,
    chapters = [],
    chapter,
    peaks,
    ticks,
    playhead,
    onSkip,
    onComment,
    onExpand,
    onCollapse,
    onRetry,
  } = props;
  if (form === "bar") {
    return (
      <div
        role="group"
        aria-label="Player"
        className="sys-player"
        data-state={state}
      >
        <div className="sys-player-left">
          <button
            type="button"
            className="sys-player-time"
            aria-label={`${time} / ${total}. Expand player`}
            onClick={onExpand}
          >
            <span className="sys-player-now">{time}</span>
            <span className="sys-player-total">{` / ${total}`}</span>
          </button>
          <StatePills {...props} />
        </div>
        <div className="sys-player-center">
          <Skip seconds={-SKIP} onSkip={onSkip} />
          <Play {...props} />
          <Skip seconds={SKIP} onSkip={onSkip} />
        </div>
        <div className="sys-player-right">
          {guest ? null : <HearOriginal {...props} />}
          <VerbButton verb="comment" onClick={onComment} />
          {state === "error" ? (
            <Button variant="link" onClick={onRetry}>
              Retry
            </Button>
          ) : null}
        </div>
      </div>
    );
  }
  return (
    <section
      aria-labelledby={headingId}
      className="sys-player sys-player--expanded"
      data-following={following ? "" : undefined}
    >
      <div className="sys-player-head">
        <div>
          <h2 id={headingId} className="sys-player-title">
            {title}
          </h2>
          {chapter !== undefined && chapters[chapter] ? (
            <p className="sys-player-chapter">{chapters[chapter].title}</p>
          ) : null}
        </div>
        <Button variant="link" onClick={onCollapse}>
          Collapse
        </Button>
      </div>
      <OverviewStrip
        height={64}
        peaks={peaks}
        ticks={ticks}
        playhead={playhead}
        label={`Episode overview, ${time} of ${total}`}
      />
      <p className="sys-player-readout">
        <span className="sys-player-now">{time}</span>
        <span className="sys-player-total">{` / ${total}`}</span>
        <StatePills {...props} />
      </p>
      <div className="sys-player-center sys-player-center--large">
        <Skip seconds={-SKIP} onSkip={onSkip} />
        <Play {...props} />
        <Skip seconds={SKIP} onSkip={onSkip} />
      </div>
      <div className="sys-player-actions">
        {guest ? null : <HearOriginal {...props} />}
        <VerbButton verb="comment" onClick={onComment} />
      </div>
      {chapters.length > 0 ? (
        <ol className="sys-player-chapters" aria-label="Chapters">
          {chapters.map((entry, index) => (
            <li key={entry.title}>
              <button
                type="button"
                className="sys-row-btn"
                aria-current={index === chapter ? "true" : undefined}
              >
                <span>{entry.title}</span>
                <span className="sys-mono">{entry.time}</span>
              </button>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
