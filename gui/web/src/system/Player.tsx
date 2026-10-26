import { type CSSProperties, useEffect, useId, useRef } from "react";
import { presenceColorVar } from "../presence/colors";
import { Button, Pill, SegmentedControl, ToggleButton } from "../ui";
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
  /** Audio error: tries again. Shown in the bar and in the expanded form. */
  onRetry?: () => void;
  /** A chapter row was chosen. The host seeks (#2292). */
  onChapter?: (index: number) => void;
  /** The "×" on the Following pill. */
  onUnfollow?: () => void;
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
  const label = `${back ? "Back" : "Forward"} ${SKIP} seconds`;
  return (
    <button
      type="button"
      className="sys-icon-btn sys-player-skip"
      aria-label={label}
      title={label}
      onClick={() => onSkip?.(seconds)}
    >
      <SystemIcon name={back ? "skip-back-15" : "skip-forward-15"} size={24} />
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

/** Back 15 s, Play and forward 15 s: the same trio in the bar and the expanded form. */
function PlayCluster(props: PlayerProps) {
  return (
    <>
      <Skip seconds={-SKIP} onSkip={props.onSkip} />
      <Play {...props} />
      <Skip seconds={SKIP} onSkip={props.onSkip} />
    </>
  );
}

/** The cuts delta: the edited length changes, so it stays beside the time. */
function CutsPill({ cuts }: Pick<PlayerProps, "cuts">) {
  return cuts ? (
    <Pill title="Length change from your cuts">
      <span className="sys-mono">{cuts}</span>
    </Pill>
  ) : null;
}

/**
 * Following, solo, mix and error Status pills. On a narrow Player the text
 * hides and the glyph stays; the text is still read.
 */
function StatePills({
  solo,
  state,
  guest,
  following,
  onUnfollow,
  onRetry,
}: PlayerProps) {
  return (
    <>
      {following ? (
        <Pill className="sys-player-pill">
          <SystemIcon name="locate-fixed" size={12} />
          <span className="sys-player-pill-text">
            Following {following.name}
          </span>
          {onUnfollow ? (
            <button
              type="button"
              className="sys-pill-x"
              aria-label={`Stop following ${following.name}`}
              title="Stop following"
              onClick={onUnfollow}
            >
              <SystemIcon name="x" size={12} />
            </button>
          ) : null}
        </Pill>
      ) : null}
      {solo && !guest ? (
        <Pill className="sys-player-pill">
          <SystemIcon name="headphones" size={12} />
          <span className="sys-player-pill-text">Solo {solo}</span>
        </Pill>
      ) : null}
      {state === "mix-updating" ? (
        <Pill className="sys-player-pill">
          <SystemIcon name="progress-ring" size={12} progress={0.3} />
          <span className="sys-player-pill-text">Updating mix</span>
        </Pill>
      ) : null}
      {state === "error" ? (
        <>
          <Pill className="sys-player-pill sys-pill--danger">
            <SystemIcon name="octagon-alert" size={12} />
            <span className="sys-player-pill-text">Audio error</span>
          </Pill>
          <Button variant="link" onClick={onRetry}>
            Retry
          </Button>
        </>
      ) : null}
    </>
  );
}

/** The A/B audition control (design system 21): A is the original, B the edit. */
function HearOriginal({ hearOriginal, onHearOriginal }: PlayerProps) {
  const original = hearOriginal ?? false;
  return (
    <SegmentedControl label="Audition" className="sys-player-ab">
      <ToggleButton
        quiet
        pressed={original}
        title="Hear the original (A)"
        aria-keyshortcuts="A"
        onClick={() => onHearOriginal?.(true)}
      >
        A
      </ToggleButton>
      <ToggleButton
        quiet
        pressed={!original}
        title="Hear the edit (B)"
        aria-keyshortcuts="B"
        onClick={() => onHearOriginal?.(false)}
      >
        B
      </ToggleButton>
    </SegmentedControl>
  );
}

/** The Player in its 56 px bar form and its expanded form. Props only. */
export function Player(props: PlayerProps) {
  const headingId = useId();
  const barToggleRef = useRef<HTMLButtonElement>(null);
  const collapseRef = useRef<HTMLButtonElement>(null);
  const lastForm = useRef(props.form);
  const {
    form,
    time,
    total,
    state,
    guest,
    title,
    chapters = [],
    chapter,
    peaks,
    ticks,
    playhead,
    onComment,
    onExpand,
    onCollapse,
    onChapter,
  } = props;
  // Expanding or collapsing swaps the control that was focused for its twin;
  // when focus was lost with it, put it on the toggle for the new state.
  useEffect(() => {
    if (lastForm.current === form) return;
    lastForm.current = form;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    (form === "bar" ? barToggleRef : collapseRef).current?.focus({
      preventScroll: true,
    });
  }, [form]);
  if (form === "bar") {
    return (
      <div
        role="group"
        aria-label="Player"
        className="sys-player-host"
        data-state={state}
      >
        <div className="sys-player">
          <div className="sys-player-left">
            <button
              ref={barToggleRef}
              type="button"
              className="sys-player-time"
              aria-label={`${time} / ${total}. Expand player`}
              onClick={onExpand}
            >
              <span className="sys-player-now">{time}</span>
              <span className="sys-player-total">{` / ${total}`}</span>
            </button>
            <CutsPill cuts={props.cuts} />
          </div>
          <div className="sys-player-center">
            <PlayCluster {...props} />
          </div>
          <div className="sys-player-right">
            {guest ? null : <HearOriginal {...props} />}
            <VerbButton verb="comment" onClick={onComment} />
            <StatePills {...props} />
          </div>
        </div>
      </div>
    );
  }
  return (
    <section
      aria-labelledby={headingId}
      className="sys-player sys-player--expanded"
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
        <button
          ref={collapseRef}
          type="button"
          className="sys-icon-btn"
          aria-label="Collapse player"
          title="Collapse player"
          onClick={onCollapse}
        >
          <SystemIcon name="chevron-down" size={16} />
        </button>
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
        <CutsPill cuts={props.cuts} />
        <StatePills {...props} />
      </p>
      <div className="sys-player-center sys-player-center--large">
        <PlayCluster {...props} />
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
                onClick={() => onChapter?.(index)}
              >
                <span className="sys-row-title">{entry.title}</span>
                <span className="sys-mono">{entry.time}</span>
              </button>
            </li>
          ))}
        </ol>
      ) : null}
    </section>
  );
}
