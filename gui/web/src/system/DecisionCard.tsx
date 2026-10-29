import {
  type CSSProperties,
  type ReactNode,
  useId,
  useRef,
  useState,
} from "react";
import { presenceColorVar } from "../presence/colors";
import { Button, EmptyState } from "../ui";
import { AbAudition } from "./AbAudition";
import {
  ActionBarInline,
  ActionPrompt,
  type ActionPromptProps,
} from "./ActionBarInline";
import type { AuditionSide } from "./auditionWindow";
import { type DecisionKind, KIND_META } from "./decisionKinds";
import { Skeleton } from "./Skeleton";
import { StatusRow } from "./StatusRow";
import {
  SuggestionWaveform,
  type SuggestionWaveformProps,
} from "./SuggestionWaveform";
import { SystemIcon } from "./SystemIcon";
import { formatSeconds, type TimeRange } from "./seconds";
import { useSwipeDecision } from "./useSwipeDecision";
import { iconOf } from "./verbDisplay";
import type { VerbId } from "./verbs";

export type DecisionCardState = "ready" | "loading" | "error" | "empty";

export type DecisionCardProps = {
  kind: DecisionKind;
  title: string;
  /** "18:36" */
  time: string;
  speaker?: { name: string; colorIndex?: number };
  /** Who proposed it, when a guest did: "Rosa". */
  suggestedBy?: string;
  excerpt?: ReactNode;
  /** With `audition`, which plays the change it frames. */
  waveform?: Omit<SuggestionWaveformProps, "icon" | "readOnly">;
  change?: TimeRange;
  why?: string;
  verb?: VerbId;
  /** Why the primary cannot be used; it is also off by swipe. */
  verbDisabledReason?: string;
  /** Seconds the change saves. Derive it from the waveform range so it follows a dragged handle. */
  savedSeconds?: number;
  audition?: {
    side: AuditionSide;
    onSide: (side: AuditionSide) => void;
    onHear?: (side: AuditionSide, segments: TimeRange[]) => void;
  };
  unsure?: {
    word: string;
    /** The transcript's best guess, "uncle". */
    guess: string;
    resolved?: boolean;
    /** "1 of 3" for the unsure-word pass. */
    step?: { index: number; total: number };
    onFix: (text: string) => void;
    onLooksRight?: () => void;
    onHear?: () => void;
  };
  comment?: {
    author: { name: string; colorIndex?: number };
    time: string;
    body: string;
    replies?: number;
  };
  /** Replaces the primary while a gate holds the verb back. */
  prompt?: ActionPromptProps;
  /** A guest sees the change, hears it and comments, and cannot decide it. */
  readOnly?: boolean;
  /** Editor guests and the owner. Defaults to everyone but a read-only guest. */
  canEdit?: boolean;
  /** `phone` fills the screen, swipes, and moves the Action bar into a dock. */
  layout?: "card" | "phone";
  state?: DecisionCardState;
  emptyAction?: { label: string; onClick: () => void };
  onRetry?: () => void;
  onVerb?: () => void;
  onKeep?: () => void;
  onLater?: () => void;
  onOpenInEdit?: () => void;
  onComment?: () => void;
};

function Swatch({ colorIndex }: { colorIndex?: number }) {
  return (
    <span
      className="sys-decision-swatch"
      style={{ "--swatch": presenceColorVar(colorIndex) } as CSSProperties}
      aria-hidden="true"
    />
  );
}

function UnsureWord({
  unsure,
  canSkip,
  onOpenInEdit,
}: {
  unsure: NonNullable<DecisionCardProps["unsure"]>;
  /** The phone dock has no Open in Edit link, so the card carries it. */
  onOpenInEdit?: () => void;
  /** A cut touching the word can be released with Looks right; the word's own card uses its verb. */
  canSkip: boolean;
}) {
  const fieldId = useId();
  const [fixing, setFixing] = useState(false);
  const [text, setText] = useState(unsure.word);
  const [empty, setEmpty] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  return (
    <div className="sys-decision-unsure">
      <p className="sys-decision-unsure-line">
        {unsure.step ? (
          <span className="sys-mono">
            {unsure.step.index} of {unsure.step.total}
          </span>
        ) : null}
        <span>
          Unsure word: is this{" "}
          <span className="sys-sugg-unsure">“{unsure.guess}”</span>?
        </span>
      </p>
      <div className="sys-decision-unsure-row">
        <Button
          variant="link"
          aria-expanded={fixing}
          aria-controls={fieldId}
          onClick={() => setFixing(!fixing)}
        >
          <SystemIcon name={iconOf("fixText")} size={16} />
          Fix text
        </Button>
        {unsure.onHear ? (
          <Button variant="link" onClick={unsure.onHear}>
            <SystemIcon name="play" size={16} />
            Hear
          </Button>
        ) : null}
        {onOpenInEdit ? (
          <Button variant="link" onClick={onOpenInEdit}>
            <SystemIcon name="stage-edit" size={16} />
            Open in Edit
          </Button>
        ) : null}
        {canSkip ? (
          <Button variant="link" onClick={unsure.onLooksRight}>
            <SystemIcon name={iconOf("approve")} size={16} />
            Looks right
          </Button>
        ) : null}
      </div>
      {fixing ? (
        <form
          id={fieldId}
          className="sys-decision-fix"
          onSubmit={(event) => {
            event.preventDefault();
            if (!text.trim()) {
              setEmpty(true);
              field.current?.focus();
              return;
            }
            unsure.onFix(text.trim());
            setFixing(false);
          }}
        >
          <input
            ref={field}
            aria-label={`Corrected text for “${unsure.word}”`}
            aria-invalid={empty}
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setEmpty(false);
            }}
          />
          <Button type="submit">Save</Button>
          {empty ? <p role="alert">Type the corrected word.</p> : null}
        </form>
      ) : null}
    </div>
  );
}

/** One decidable item. On phone it fills the screen and swipes decide it. */
export function DecisionCard(props: DecisionCardProps) {
  const {
    kind,
    title,
    time,
    speaker,
    suggestedBy,
    excerpt,
    waveform,
    why,
    verb,
    verbDisabledReason,
    savedSeconds,
    audition,
    unsure,
    comment,
    prompt,
    readOnly = false,
    canEdit,
    layout = "card",
    state = "ready",
    emptyAction,
    onRetry,
    onVerb,
    onKeep,
    onLater,
    onOpenInEdit,
    onComment,
  } = props;
  const headingId = useId();
  const verbNoteId = useId();
  const meta = KIND_META[kind];
  const phone = layout === "phone";
  const holdVerb =
    unsure !== undefined && kind !== "unsure-word" && !unsure.resolved;
  const verbHeld = holdVerb || verbDisabledReason !== undefined;
  const swipe = useSwipeDecision(
    { verb: verbHeld ? undefined : onVerb, keep: onKeep, next: onLater },
    { disabled: !phone || readOnly || state !== "ready" },
  );

  if (state !== "ready") {
    return (
      <section
        className="sys-decision"
        data-layout={layout}
        data-state={state}
        aria-label="Decision"
      >
        {state === "loading" ? <Skeleton layout="cards" rows={3} /> : null}
        {state === "error" ? (
          <StatusRow
            state="failed"
            title="Could not load this one"
            detail="Your other decisions are saved."
            action={
              onRetry ? { label: "Try again", onAction: onRetry } : undefined
            }
          />
        ) : null}
        {state === "empty" ? (
          <div className="sys-decision-empty">
            <SystemIcon name="inbox" size={48} />
            <EmptyState as="div" action={emptyAction}>
              Nothing to decide
            </EmptyState>
          </div>
        ) : null}
      </section>
    );
  }

  const change: TimeRange | null = waveform
    ? { start: waveform.start, end: waveform.end }
    : (props.change ?? null);
  const drag = swipe.drag?.intent === "verb" && verbHeld ? null : swipe.drag;
  const revealIcon =
    drag?.intent === "verb"
      ? iconOf(verb ?? meta.verb)
      : drag?.intent === "keep"
        ? iconOf("keep")
        : iconOf("later");

  const ab =
    audition && change ? (
      <AbAudition
        side={audition.side}
        change={change}
        onSelect={(side, segments) => {
          audition.onSide(side);
          audition.onHear?.(side, segments);
        }}
      />
    ) : null;
  const abInBar = phone || readOnly;

  return (
    <article
      className="sys-decision"
      data-kind={kind}
      data-layout={layout}
      data-state="ready"
      aria-labelledby={headingId}
      style={
        drag
          ? ({
              "--swipe-x": `${drag.dx}px`,
              "--swipe-y": `${Math.min(0, drag.dy)}px`,
            } as CSSProperties)
          : undefined
      }
      data-swipe={drag?.committed ? drag.intent : undefined}
    >
      {phone && drag?.intent ? (
        <div
          className="sys-decision-reveal"
          data-intent={drag.intent}
          aria-hidden="true"
        >
          <span
            style={{ "--grow": 0.6 + 0.4 * drag.progress } as CSSProperties}
          >
            <SystemIcon name={revealIcon} size={32} />
          </span>
        </div>
      ) : null}
      <div className="sys-decision-body" {...swipe.bind}>
        <p className="sys-decision-kind">
          <SystemIcon name={meta.icon} size={16} />
          <span>{meta.label}</span>
          <span className="sys-mono">{time}</span>
          {speaker ? (
            <span className="sys-decision-speaker">
              <Swatch colorIndex={speaker.colorIndex} />
              {speaker.name}
            </span>
          ) : null}
          {suggestedBy ? (
            <span className="sys-decision-guest">
              Suggested by {suggestedBy}
            </span>
          ) : null}
        </p>
        <h2 id={headingId} className="sys-decision-title">
          {title}
        </h2>
        {excerpt ? <p className="sys-decision-excerpt">{excerpt}</p> : null}
        {comment && kind === "comment" ? (
          <blockquote className="sys-decision-comment">
            <p className="sys-decision-comment-by">
              <Swatch colorIndex={comment.author.colorIndex} />
              {comment.author.name}
              <span className="sys-mono">{comment.time}</span>
            </p>
            <p>{comment.body}</p>
            {comment.replies ? (
              <p className="sys-decision-comment-replies">
                {comment.replies === 1
                  ? "1 reply"
                  : `${comment.replies} replies`}
              </p>
            ) : null}
          </blockquote>
        ) : null}
        {waveform && KIND_META[kind].wave ? (
          <>
            <SuggestionWaveform
              {...waveform}
              icon={meta.icon}
              readOnly={readOnly}
              onAdjustStart={() => {
                waveform.onAdjustStart?.();
                if (audition && audition.side !== "B") audition.onSide("B");
              }}
            />
            {savedSeconds === undefined ? null : (
              <p className="sys-decision-saves sys-mono" aria-live="polite">
                Saves {formatSeconds(savedSeconds)}
              </p>
            )}
          </>
        ) : null}
        {why ? <p className="sys-decision-why">{why}</p> : null}
        {verbDisabledReason && !readOnly ? (
          <p id={verbNoteId} className="sys-decision-why">
            {verbDisabledReason}
          </p>
        ) : null}
        {unsure && !readOnly ? (
          <UnsureWord
            unsure={unsure}
            canSkip={kind !== "unsure-word" && !unsure.resolved}
            onOpenInEdit={phone && canEdit !== false ? onOpenInEdit : undefined}
          />
        ) : null}
        {abInBar ? null : ab}
      </div>
      {prompt && !readOnly ? <ActionPrompt {...prompt} /> : null}
      <ActionBarInline
        form={phone ? "dock" : "inline"}
        verb={verb ?? meta.verb}
        verbLabel={verb && verb !== meta.verb ? undefined : meta.verbLabel}
        verbNoteId={verbNoteId}
        verbDisabledReason={
          holdVerb ? "Check the unsure word first." : verbDisabledReason
        }
        readOnly={readOnly}
        canEdit={canEdit}
        promptOpen={prompt !== undefined}
        center={abInBar ? ab : undefined}
        onKeep={onKeep}
        onVerb={onVerb}
        onLater={onLater}
        onOpenInEdit={onOpenInEdit}
        onComment={onComment}
      />
      {comment && kind !== "comment" ? (
        <p className="sys-decision-thread">
          <SystemIcon name={iconOf("comment")} size={14} />
          <span className="sys-decision-thread-by">{comment.author.name}</span>
          <span className="sys-decision-thread-body">{comment.body}</span>
        </p>
      ) : null}
    </article>
  );
}
