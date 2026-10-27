import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { useLongPress } from "../hooks/useLongPress";
import { presenceColorVar } from "../presence/colors";
import {
  Button,
  Menu,
  MenuSection,
  Pill,
  SegmentedControl,
  ToggleButton,
} from "../ui";
import { OverviewStrip, type OverviewTick } from "./OverviewStrip";
import { SystemIcon } from "./SystemIcon";
import { VerbButton } from "./VerbButton";

export type PlayerChapter = { title: string; time: string; at: number };

/** What the A/B control plays: the full mix, the edited stems without mix processing, or the original. */
export type HearMode = "mix" | "edited" | "original";

const HEAR_MODES: readonly { id: HearMode; label: string }[] = [
  { id: "mix", label: "Full mix" },
  { id: "edited", label: "Without mix processing" },
  { id: "original", label: "Original" },
];

export type PlayerProps = {
  form: "bar" | "expanded";
  playing: boolean;
  time: string;
  total: string;
  /** Edited-length delta, e.g. `−4:10`. */
  cuts?: string;
  /** Mix is re-rendering: a ring on Play and a Status pill. */
  state?: "ready" | "loading" | "mix-updating" | "error";
  /**
   * The mix's status ("No mix yet", "Mix out of date") or why Play cannot
   * start ("Import audio to play."), as a visible status line.
   */
  status?: string;
  /** Play cannot start: it is aria-disabled and `status` is its description. */
  playUnavailable?: boolean;
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
  /**
   * A press on A hears the original at once. Released quickly it stays on
   * (latched); held past `HOLD_MS` it returns to what was playing on release.
   */
  onHearOriginal?: (on: boolean) => void;
  /**
   * The hear menu, opened by a right-click, a long press or its chevron. Omit
   * it for a guest, who hears the mix only.
   */
  hearMenu?: { mode: HearMode; onMode: (mode: HearMode) => void };
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

function Play({
  playing,
  state,
  following,
  playUnavailable,
  statusId,
  onPlayPause,
}: PlayerProps & { statusId: string }) {
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
        aria-disabled={playUnavailable || undefined}
        aria-describedby={playUnavailable ? statusId : undefined}
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
function PlayCluster(props: PlayerProps & { statusId: string }) {
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

/** The status line: the mix's state or why Play cannot start. Names Play's description. */
function StatusLine({
  status,
  id,
}: Pick<PlayerProps, "status"> & { id: string }) {
  return status ? (
    <span id={id} className="sys-player-status">
      <Pill className="sys-player-pill">
        <SystemIcon name="triangle-alert" size={12} />
        <span className="sys-player-pill-text">{status}</span>
      </Pill>
    </span>
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

/** A press on A longer than this is a hold: letting go goes back to what was playing. */
const HOLD_MS = 250;

/** Hold-to-hear on A: down hears the original, a quick release latches it, a held release restores. */
function useHoldToHear(
  original: boolean,
  onHearOriginal: PlayerProps["onHearOriginal"],
) {
  const press = useRef<{ at: number; was: boolean } | null>(null);
  const swallowClick = useRef(false);
  const release = (cancelled: boolean) => {
    const current = press.current;
    press.current = null;
    if (!current) return;
    const held = performance.now() - current.at >= HOLD_MS;
    if (!current.was && (held || cancelled)) {
      swallowClick.current = held;
      onHearOriginal?.(false);
    }
  };
  return {
    onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      swallowClick.current = false;
      press.current = { at: performance.now(), was: original };
      event.currentTarget.setPointerCapture?.(event.pointerId);
      if (!original) onHearOriginal?.(true);
    },
    onPointerUp: () => release(false),
    onPointerCancel: () => release(true),
    onClick: () => {
      if (swallowClick.current) {
        swallowClick.current = false;
        return;
      }
      onHearOriginal?.(true);
    },
  };
}

/**
 * The A/B audition control (design system 21): A is the original, B the edit.
 * Right-click or long-press it, or use the chevron, for the hear menu.
 */
function HearOriginal({
  hearOriginal,
  onHearOriginal,
  hearMenu,
}: Pick<PlayerProps, "hearOriginal" | "onHearOriginal" | "hearMenu">) {
  const original = hearOriginal ?? false;
  const [open, setOpen] = useState(false);
  const hold = useHoldToHear(original, onHearOriginal);
  // A held A is the hold gesture, so a long press there never opens the menu.
  const longPress = useLongPress((target) => {
    if (target instanceof Element && target.closest(".sys-player-a")) return;
    setOpen(true);
  });
  const group = (
    <SegmentedControl label="Audition" className="sys-player-ab">
      <ToggleButton
        quiet
        className="sys-player-a"
        pressed={original}
        title="Hear the original (A)"
        aria-keyshortcuts="A"
        {...hold}
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
  if (!hearMenu) return group;
  return (
    <span
      className="sys-player-hear"
      onContextMenu={(event) => {
        event.preventDefault();
        setOpen(true);
      }}
      {...longPress}
    >
      {group}
      <Menu
        open={open}
        onOpenChange={setOpen}
        label="Hear"
        className="ui-menu-root sys-menu sys-player-hear-menu"
        trigger={(props) => (
          <button
            type="button"
            className="sys-icon-btn sys-player-hear-more"
            aria-label="Hear options"
            title="Hear options"
            {...props}
          >
            <SystemIcon name="chevron-down" size={16} />
          </button>
        )}
      >
        <MenuSection label="Hear">
          <SegmentedControl role="none" className="sys-player-hear-modes">
            {HEAR_MODES.map((entry) => (
              <ToggleButton
                key={entry.id}
                quiet
                role="menuitemradio"
                tabIndex={-1}
                pressed={hearMenu.mode === entry.id}
                aria-checked={hearMenu.mode === entry.id}
                onClick={() => {
                  setOpen(false);
                  hearMenu.onMode(entry.id);
                }}
              >
                {entry.label}
              </ToggleButton>
            ))}
          </SegmentedControl>
        </MenuSection>
      </Menu>
    </span>
  );
}

/** The Player in its 56 px bar form and its expanded form. Props only. */
export function Player(props: PlayerProps) {
  const headingId = useId();
  const statusId = useId();
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
            <PlayCluster {...props} statusId={statusId} />
          </div>
          <div className="sys-player-right">
            {guest ? null : (
              <HearOriginal
                hearOriginal={props.hearOriginal}
                onHearOriginal={props.onHearOriginal}
                hearMenu={props.hearMenu}
              />
            )}
            {onComment ? (
              <VerbButton verb="comment" onClick={onComment} />
            ) : null}
            <StatusLine status={props.status} id={statusId} />
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
        <StatusLine status={props.status} id={statusId} />
        <StatePills {...props} />
      </p>
      <div className="sys-player-center sys-player-center--large">
        <PlayCluster {...props} statusId={statusId} />
      </div>
      <div className="sys-player-actions">
        {guest ? null : (
          <HearOriginal
            hearOriginal={props.hearOriginal}
            onHearOriginal={props.onHearOriginal}
            hearMenu={props.hearMenu}
          />
        )}
        {onComment ? <VerbButton verb="comment" onClick={onComment} /> : null}
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
