import { type CSSProperties, type ReactNode, useId, useState } from "react";
import { presenceColorVar } from "../presence/colors";
import { KIND_META, type ReviewKind } from "../review/reviewKinds";
import { useSwipeDecision } from "../review/useSwipeDecision";
import { Button, EmptyState } from "../ui";
import { AbAudition } from "./AbAudition";
import {
  ActionBarInline,
  ActionPrompt,
  type ActionPromptProps,
} from "./ActionBarInline";
import type { AuditionSegment, AuditionSide } from "./auditionWindow";
import { Skeleton } from "./Skeleton";
import { StatusRow } from "./StatusRow";
import {
  SuggestionWaveform,
  type SuggestionWaveformProps,
} from "./SuggestionWaveform";
import { SystemIcon } from "./SystemIcon";
import type { SuggestionRange } from "./silenceSnap";
import { verbOf } from "./verbDisplay";

export type DecisionCardState = "ready" | "loading" | "error" | "empty";

export type DecisionCardProps = {
  kind: ReviewKind;
  title: string;
  /** "18:36" */
  time: string;
  speaker?: { name: string; colorIndex?: number };
  /** A guest's suggestion shown to the host: "Rosa". */
  suggestedBy?: string;
  /** Script excerpt with the Suggestion drawing. */
  excerpt?: ReactNode;
  waveform?: Omit<SuggestionWaveformProps, "kind">;
  /** One plain line from whoever proposed the change. */
  why?: string;
  /** "Saves 0.8 s", live while a handle moves. */
  saves?: string;
  audition?: {
    side: AuditionSide;
    onSide: (side: AuditionSide) => void;
    onHear?: (side: AuditionSide, segments: AuditionSegment[]) => void;
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
  };
  comment?: {
    author: { name: string; colorIndex?: number };
    time: string;
    body: string;
    replies?: number;
  };
  /** The held-back verb's prompt, while a gate is open. */
  prompt?: ActionPromptProps;
  /** Overrides the word on the primary button. */
  verbLabel?: string;
  /** A guest sees the change and cannot decide it. */
  readOnly?: boolean;
  /** `phone` fills the screen, swipes, and moves the Action bar into a dock. */
  layout?: "card" | "phone";
  state?: DecisionCardState;
  emptyAction?: { label: string; onAction: () => void };
  onRetry?: () => void;
  onVerb?: () => void;
  onKeep?: () => void;
  onLater?: () => void;
  onOpenInEdit?: () => void;
};

const WAVE_KINDS = ["filler", "pause", "sound"] as const;
type WaveKind = (typeof WAVE_KINDS)[number];
const isWaveKind = (kind: ReviewKind): kind is WaveKind =>
  (WAVE_KINDS as readonly string[]).includes(kind);

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
  kind,
  unsure,
}: {
  kind: ReviewKind;
  unsure: NonNullable<DecisionCardProps["unsure"]>;
}) {
  const fieldId = useId();
  const [fixing, setFixing] = useState(false);
  const [text, setText] = useState(unsure.word);
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
          <SystemIcon name="text-cursor-input" size={16} />
          Fix text
        </Button>
        {kind !== "unsure-word" && !unsure.resolved ? (
          <Button variant="link" onClick={unsure.onLooksRight}>
            <SystemIcon name="check" size={16} />
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
            unsure.onFix(text.trim());
            setFixing(false);
          }}
        >
          <input
            aria-label="Fix text"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
          <Button type="submit">Save</Button>
        </form>
      ) : null}
    </div>
  );
}

/**
 * The focus surface for one decidable thing: kind line, plain title, excerpt,
 * a 96 px waveform with handles, the why line, A/B and the Action bar. On
 * phone it fills the screen: swipe right does the verb, left keeps, up moves
 * on, and A/B joins Keep and the verb in the dock.
 */
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
    saves,
    audition,
    unsure,
    comment,
    prompt,
    verbLabel,
    readOnly = false,
    layout = "card",
    state = "ready",
    emptyAction,
    onRetry,
    onVerb,
    onKeep,
    onLater,
    onOpenInEdit,
  } = props;
  const headingId = useId();
  const meta = KIND_META[kind];
  const phone = layout === "phone";
  const swipe = useSwipeDecision(
    { verb: onVerb, keep: onKeep, next: onLater },
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
            action={{ label: "Try again", onAction: () => onRetry?.() }}
          />
        ) : null}
        {state === "empty" ? (
          <div className="sys-decision-empty">
            <SystemIcon name="inbox" size={48} />
            <EmptyState
              as="div"
              action={
                emptyAction
                  ? { label: emptyAction.label, onClick: emptyAction.onAction }
                  : undefined
              }
            >
              Nothing to decide
            </EmptyState>
          </div>
        ) : null}
      </section>
    );
  }

  const change: SuggestionRange | null = waveform
    ? { start: waveform.start, end: waveform.end }
    : null;
  const blocked =
    unsure && kind !== "unsure-word" && !unsure.resolved
      ? "Check the unsure word first."
      : undefined;
  const verb = meta.verb;
  const label = verbLabel ?? ("verbLabel" in meta ? meta.verbLabel : undefined);
  const drag = swipe.drag;
  const dragVerb = drag?.intent === "verb" ? verbOf(verb) : null;

  const audio =
    waveform && change && isWaveKind(kind) ? (
      <>
        <SuggestionWaveform
          {...waveform}
          kind={kind}
          readOnly={readOnly || waveform.readOnly}
          onAdjustStart={() => {
            waveform.onAdjustStart?.();
            if (audition && audition.side !== "B") audition.onSide("B");
          }}
        />
        {saves ? (
          <p className="sys-decision-saves sys-mono" aria-live="polite">
            {saves}
          </p>
        ) : null}
      </>
    ) : null;

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
            <SystemIcon
              name={
                drag.intent === "verb"
                  ? (dragVerb?.icon ?? "check")
                  : drag.intent === "keep"
                    ? "shield-check"
                    : "chevron-down"
              }
              size={32}
            />
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
        {audio}
        {why ? <p className="sys-decision-why">{why}</p> : null}
        {unsure ? <UnsureWord kind={kind} unsure={unsure} /> : null}
        {phone ? null : ab}
      </div>
      {prompt && !readOnly ? <ActionPrompt {...prompt} /> : null}
      <ActionBarInline
        form={phone ? "dock" : "inline"}
        verb={verb}
        verbLabel={label}
        verbDisabledReason={blocked}
        readOnly={readOnly}
        promptOpen={prompt !== undefined}
        center={phone ? ab : undefined}
        onKeep={onKeep}
        onVerb={onVerb}
        onLater={onLater}
        onOpenInEdit={onOpenInEdit}
      />
      {comment && kind !== "comment" ? (
        <p className="sys-decision-thread">
          <SystemIcon name="message-square" size={14} />
          <span className="sys-decision-thread-by">{comment.author.name}</span>
          <span className="sys-decision-thread-body">{comment.body}</span>
        </p>
      ) : null}
    </article>
  );
}
