import type { CSSProperties, ReactNode } from "react";
import { Avatar } from "../ui";
import { type DecisionKind, KIND_META } from "./decisionKinds";
import { SystemIcon } from "./SystemIcon";
import { SWIPE_IGNORE_ROW, useSwipeDecision } from "./useSwipeDecision";
import { iconOf } from "./verbDisplay";

export type QueueRowResult = {
  result: "applied" | "kept";
  /** "Cut 0.8 s", "Kept". */
  text: string;
};

export type QueueRowProps = {
  kind: DecisionKind;
  /** The Suggestion drawing for a proposal, or the quoted comment. */
  snippet: ReactNode;
  /** "18:36" */
  time: string;
  /** Saved seconds ("0.8 s") or a reply count ("2 replies"). */
  value?: string;
  selected?: boolean;
  /** A comment row shows who wrote it instead of the kind glyph. */
  author?: { name: string; colorIndex?: number };
  unread?: boolean;
  /** Waiting to send: the guest is offline. */
  offline?: boolean;
  decided?: QueueRowResult;
  onSelect?: () => void;
  /** Swipe right does the primary and left keeps. */
  onVerb?: () => void;
  onKeep?: () => void;
};

const RESULT_ICON = {
  applied: iconOf("approve"),
  kept: iconOf("keep"),
} as const;

/** 56 px. A decided row is one quiet line with its result. */
export function QueueRow({
  kind,
  snippet,
  time,
  value,
  selected = false,
  author,
  unread = false,
  offline = false,
  decided,
  onSelect,
  onVerb,
  onKeep,
}: QueueRowProps) {
  const swipe = useSwipeDecision(
    { verb: onVerb, keep: onKeep },
    {
      disabled: decided !== undefined || (!onVerb && !onKeep),
      ignore: SWIPE_IGNORE_ROW,
    },
  );
  const meta = KIND_META[kind];
  if (decided) {
    return (
      <div className="sys-queue-row sys-queue-row--decided" data-kind={kind}>
        <SystemIcon name={RESULT_ICON[decided.result]} size={16} />
        <span className="sys-queue-decided-text">{decided.text}</span>
        <span className="sys-mono sys-queue-time">{time}</span>
      </div>
    );
  }
  const offset = swipe.drag
    ? ({ "--swipe-x": `${swipe.drag.dx}px` } as CSSProperties)
    : undefined;
  return (
    <div
      className="sys-queue-row"
      data-kind={kind}
      data-selected={selected || undefined}
      data-swipe={swipe.drag?.committed ? swipe.drag.intent : undefined}
      style={offset}
      {...swipe.bind}
    >
      <button
        type="button"
        className="sys-queue-main"
        aria-current={selected ? "true" : undefined}
        onClick={() => {
          if (!swipe.wasDrag()) onSelect?.();
        }}
      >
        <span className="sys-queue-lead">
          {author ? (
            <Avatar
              name={author.name}
              colorIndex={author.colorIndex}
              size="sm"
            />
          ) : (
            <SystemIcon name={meta.icon} size={16} title={meta.label} />
          )}
        </span>
        <span className="sys-queue-snippet">{snippet}</span>
        <span className="sys-queue-meta">
          <span className="sys-mono sys-queue-time">{time}</span>
          {value ? (
            <span className="sys-mono sys-queue-value">{value}</span>
          ) : null}
        </span>
        {unread ? (
          <span className="sys-queue-unread" role="img" aria-label="Unread" />
        ) : null}
        {offline ? (
          <SystemIcon
            name="cloud-off"
            size={14}
            title="Waiting to send"
            className="sys-tone-warning"
          />
        ) : null}
      </button>
    </div>
  );
}
