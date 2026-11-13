import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { useNowSec } from "../hooks/useNowSec";
import { ModelNeedRow } from "../models";
import {
  DISMISS_FAILED_NOTE,
  dismissReason,
  NEEDS_ATTENTION,
  UNREADABLE_NOTE,
} from "../stage/frame/attentionLabel";
import type { DecisionCardProps } from "../system/DecisionCard";
import { type DecisionKind, KIND_META } from "../system/decisionKinds";
import { QueueRow, type QueueRowProps } from "../system/QueueRow";
import { Skeleton } from "../system/Skeleton";
import { StatusRow } from "../system/StatusRow";
import { SystemIcon } from "../system/SystemIcon";
import { formatSeconds } from "../system/seconds";
import type { TakeSwitcherProps } from "../system/TakeSwitcher";
import { VerbButton } from "../system/VerbButton";
import { hintOf, iconOf, verbOf } from "../system/verbDisplay";
import type { VerbId } from "../system/verbs";
import { Button, EmptyState, SegmentedControl, ToggleButton } from "../ui";
import { disabledAttrs, useDisabledReasonNote } from "../ui/disabledReason";
import type { ModelNeeded } from "../utils/apiError";
import { formatTimeShort } from "../utils/time";
import type { ConflictSuggestion } from "./conflictRows";
import { RefineGateWaiver } from "./RefineGateWaiver";
import {
  type ReviewDetailKind,
  reviewCompletenessOf,
  reviewSubsetCount,
} from "./reviewCompleteness";
import {
  type AttentionRow,
  attentionLabelOf,
  attentionVisible,
  commentLine,
  decidedItems,
  dismissHeld,
  filterItems,
  groupQueue,
  kindInFilter,
  lowRiskBulk,
  pendingLabelOf,
  progressLine,
  REVIEW_ATTENTION_ID,
  type ReviewAttention,
  type ReviewFilter,
  type ReviewGroup,
  type ReviewItem,
  type ReviewSort,
  resultText,
  speakersOf,
  timeQueue,
} from "./reviewQueueModel";

export type UnsureContext = {
  readonly before: readonly string[];
  readonly focus: string;
  readonly after: readonly string[];
};

export type ReviewContent = {
  row: Pick<
    QueueRowProps,
    "snippet" | "time" | "value" | "author" | "unread" | "offline"
  >;
  check?: { title: string; detail?: string; actionLabel: string };
  /** A held pickup: the line that asks before it goes ahead anyway. */
  confirm?: { message: string };
  /** A replace pickup with several takes: the switcher's data. The stage adds `onSelect`. */
  takes?: Omit<TakeSwitcherProps, "onSelect">;
  card: Pick<
    DecisionCardProps,
    | "title"
    | "time"
    | "speaker"
    | "suggestedBy"
    | "excerpt"
    | "waveform"
    | "why"
    | "comment"
    | "change"
  > & {
    unsure?: {
      word: string;
      guess: string;
      disabledReason?: string;
      id?: string;
      editorIdentity?: NonNullable<
        DecisionCardProps["unsure"]
      >["editorIdentity"];
      step?: { index: number; total: number };
      context?: UnsureContext;
    };
  };
};

/** `done` is absent when the host reports no count: the row then says how long it has run. */
export type BulkProgress = {
  kind: DecisionKind;
  total: number;
  done?: number;
  startedAtSec?: number;
};

export type QueueJob = {
  title: string;
  progress?: number;
  error?: string;
  /** The model the run stopped on: its Model need row shows here and the run resumes when it lands. */
  needs?: ModelNeeded;
};

export type ReviewQueueProps = {
  items: readonly ReviewItem[];
  content: (item: ReviewItem) => ReviewContent;
  selectedId: string | null;
  filter: ReviewFilter;
  /** The person whose edits show; absent or null for everyone. */
  speaker?: string | null;
  /** By kind (default) or by where each edit sits in the episode. */
  sort?: ReviewSort;
  /** The pipeline job finding suggestions, or the error of the one that failed. */
  job?: QueueJob;
  bulkRunning?: BulkProgress;
  /** A guest has no Find more. */
  guest?: boolean;
  /** Without it the queue is comments only: no bulk verbs, Cut or Keep, swipes. */
  canDecide?: boolean;
  state?: "ready" | "loading" | "error";
  detailKind?: ReviewDetailKind;
  /** A share guest's edits that did not apply. */
  attention?: ReviewAttention;
  onFilter: (filter: ReviewFilter) => void;
  /** Without it the queue shows no speaker chips. */
  onSpeaker?: (speaker: string | null) => void;
  /** Without it the queue shows no sort control. */
  onSort?: (sort: ReviewSort) => void;
  onSelect: (id: string) => void;
  /** A comment row was activated by click or Enter: audition its clip. */
  onPlayComment?: (id: string) => void;
  onVerb?: (id: string) => void;
  onKeep?: (id: string) => void;
  onBulk?: (group: ReviewGroup) => void;
  /** The top row's batch: every kind's clean cuts at once. */
  onBulkIds?: (ids: readonly string[]) => void;
  onFindMore?: () => void;
  /** Why Find more cannot start now. */
  findMoreDisabled?: string;
  onRetry?: () => void;
};

const FILTERS: readonly {
  id: ReviewFilter;
  label: string;
  icon: ReactNode;
}[] = [
  { id: "all", label: "All", icon: null },
  {
    id: "suggestions",
    label: "Suggestions",
    icon: <SystemIcon name={iconOf("cut")} size={14} />,
  },
  {
    id: "comments",
    label: "Comments",
    icon: <SystemIcon name={iconOf("comment")} size={14} />,
  },
  {
    id: "checks",
    label: "Checks",
    icon: <SystemIcon name="triangle-alert" size={14} />,
  },
];

const GERUND: Partial<Record<VerbId, string>> = {
  cut: "Cutting",
  shorten: "Shortening",
  lower: "Lowering",
};

const ELAPSED_AFTER_SEC = 2;

/** Shown even after the group has left the queue, because a decision hides it at once. */
function BulkRow({ running }: { running: BulkProgress }) {
  const { done, startedAtSec, total } = running;
  const { verb: id } = KIND_META[running.kind];
  const nowSec = useNowSec(startedAtSec !== undefined);
  const elapsed = Math.max(0, nowSec - (startedAtSec ?? nowSec));
  return (
    <StatusRow
      state="running"
      density="inline"
      title={`${GERUND[id] ?? verbOf(id).label} ${total}${done === undefined ? "…" : ""}`}
      detail={
        done !== undefined
          ? `${done} done`
          : elapsed >= ELAPSED_AFTER_SEC
            ? `${formatTimeShort(elapsed)} so far`
            : undefined
      }
      progress={done === undefined ? undefined : done / total}
    />
  );
}

function GroupHeader({
  group,
  running,
  canDecide,
  onBulk,
  count,
}: {
  group: ReviewGroup;
  running?: BulkProgress;
  canDecide: boolean;
  onBulk?: (group: ReviewGroup) => void;
  count: number | null;
}) {
  const meta = KIND_META[group.kind];
  if (running) return <BulkRow running={running} />;
  const bulk = canDecide ? group.bulk : null;
  const verb = bulk ? verbOf(bulk.verb) : null;
  const heldId = `rv-held-${group.kind}`;
  const bulkLabel =
    bulk && verb
      ? bulk.ids.length === 1
        ? verb.label
        : `${verb.label} all ${bulk.ids.length}`
      : "";
  return (
    <div className="rv-group-head">
      <SystemIcon name={meta.icon} size={16} />
      <span className="rv-group-name">{group.label}</span>
      <span className="sys-mono rv-group-count">
        {count ?? "Count unavailable"}
      </span>
      {bulk && verb?.icon ? (
        <>
          <span className="sys-mono">{formatSeconds(bulk.savedSeconds)}</span>
          <Button
            className="rv-bulk"
            aria-label={
              bulk.ids.length === 1 ? `${bulkLabel} this one` : bulkLabel
            }
            aria-describedby={group.held > 0 ? heldId : undefined}
            onClick={() => onBulk?.(group)}
            title={`${bulkLabel}${hintOf(verbOf("applyAll"))}`}
          >
            <SystemIcon name={verb.icon} size={14} />
            {bulkLabel}
          </Button>
        </>
      ) : null}
      {group.held > 0 && canDecide ? (
        <span id={heldId} className="sys-mono">
          {group.held} to decide one by one
        </span>
      ) : null}
    </div>
  );
}

/** A guest cut a newer host edit overlaps: Hear it, suggest it again, or drop it. */
function SuggestionRow({
  row,
  suggestion,
  actions,
}: {
  row: AttentionRow;
  suggestion: ConflictSuggestion;
  actions: NonNullable<ReviewAttention["suggestionActions"]>;
}) {
  return (
    <StatusRow
      state="needs-you"
      title={suggestion.title}
      secondaryAction={{
        label: "Hear",
        name: suggestion.names.hear,
        onAction: () => actions.onHear(row),
        disabledReason: actions.hearBlocked,
      }}
      action={{
        label: "Suggest again here",
        name: suggestion.names.suggestAgain,
        onAction: () => {
          void actions.onSuggestAgain(row);
        },
      }}
      tertiaryAction={{
        label: "Drop it",
        name: suggestion.names.drop,
        onAction: () => {
          void actions.onDrop(row);
        },
      }}
    />
  );
}

/** Focus fell back to the page or a container once its element left, rather than moved on. */
const focusFellBack = (active: Element | null): boolean =>
  !active ||
  active === document.body ||
  (active instanceof HTMLElement &&
    active.tabIndex < 0 &&
    !active.matches("input, select, textarea, [contenteditable]"));

function AttentionGroup({
  attention,
  waivedIds,
  onWaived,
  onFocusChange,
  onVanished,
}: {
  attention: ReviewAttention;
  waivedIds: ReadonlySet<string>;
  onWaived: (ids: readonly string[]) => void;
  onFocusChange: (inside: boolean) => void;
  onVanished: () => void;
}) {
  const { rows, pending, refineWaiverProject } = attention;
  const reasonId = useId();
  const groupRef = useRef<HTMLDivElement>(null);
  const leaving = useRef<{ id: string; index: number } | null>(null);
  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    const enter = () => {
      leaving.current = null;
      onFocusChange(true);
    };
    const leave = (event: FocusEvent) => {
      if (group.contains(event.relatedTarget as Node | null)) return;
      // Focus moved out while its element survives (a click-away or tab-out), not
      // because the element was removed (some engines fire focusout mid-removal, so
      // look once the removal has landed): the guest chose to go, so a later row
      // removal must not pull focus back.
      const target = event.target as Node | null;
      queueMicrotask(() => {
        if (target?.isConnected) leaving.current = null;
      });
      onFocusChange(false);
    };
    group.addEventListener("focusin", enter);
    group.addEventListener("focusout", leave);
    return () => {
      group.removeEventListener("focusin", enter);
      group.removeEventListener("focusout", leave);
    };
  }, [onFocusChange]);
  const vanished = useRef(onVanished);
  useEffect(() => {
    vanished.current = onVanished;
  });
  useEffect(
    () => () => {
      if (leaving.current) vanished.current();
    },
    [],
  );
  useEffect(() => {
    const mark = leaving.current;
    if (!mark || rows.some((row) => row.id === mark.id)) return;
    leaving.current = null;
    if (!focusFellBack(document.activeElement)) return;
    const group = groupRef.current;
    if (!group) return;
    const next = rows[Math.min(mark.index, rows.length - 1)];
    const target = next
      ? group.querySelector<HTMLElement>(
          `[data-attention-row="${CSS.escape(next.id)}"] button`,
        )
      : null;
    (target ?? group).focus();
  }, [rows]);
  const leaveAfter =
    (act: (row: AttentionRow) => void | Promise<void>) =>
    (row: AttentionRow) => {
      leaving.current = {
        id: row.id,
        index: rows.findIndex((r) => r.id === row.id),
      };
      return act(row);
    };
  const held = dismissHeld(attention);
  const failure = attention.unreadable
    ? UNREADABLE_NOTE
    : attention.dismissFailed
      ? DISMISS_FAILED_NOTE
      : null;
  return (
    <div
      ref={groupRef}
      id={REVIEW_ATTENTION_ID}
      role="group"
      className="rv-group"
      tabIndex={-1}
      aria-label={attentionLabelOf(attention)}
    >
      <div className="rv-group-head">
        <SystemIcon name="triangle-alert" size={16} />
        <span className="rv-group-name">{NEEDS_ATTENTION}</span>
        <span className="sys-mono rv-group-count">
          {pending + rows.length || "!"}
        </span>
        {rows.length > 0 && attention.canDismiss ? (
          <Button
            aria-disabled={held || undefined}
            aria-describedby={held ? reasonId : undefined}
            title={held ? dismissReason(attention) : undefined}
            onClick={() => {
              if (!held) attention.onDismissAll();
            }}
          >
            Dismiss all
          </Button>
        ) : null}
      </div>
      {held && rows.length > 0 && attention.canDismiss ? (
        <p id={reasonId} className="ui-field-hint rv-group-reason">
          {dismissReason(attention)}
        </p>
      ) : null}
      {failure ? (
        <StatusRow
          state="failed"
          title={failure}
          action={{ label: "Retry", onAction: attention.onRetry }}
        />
      ) : null}
      {pending > 0 ? (
        <div className="rv-check">
          <StatusRow
            state="needs-you"
            title={pendingLabelOf(pending)}
            action={
              attention.onSendNow
                ? { label: "Send now", onAction: attention.onSendNow }
                : undefined
            }
          />
        </div>
      ) : null}
      {rows.map((row) => (
        <div key={row.id} className="rv-check" data-attention-row={row.id}>
          {row.suggestion && attention.suggestionActions ? (
            <SuggestionRow
              row={row}
              suggestion={row.suggestion}
              actions={{
                ...attention.suggestionActions,
                onSuggestAgain: leaveAfter(
                  attention.suggestionActions.onSuggestAgain,
                ),
                onDrop: leaveAfter(attention.suggestionActions.onDrop),
              }}
            />
          ) : (
            <StatusRow
              state="needs-you"
              title={row.title}
              detail={row.detail || undefined}
              action={
                row.inspectHistory && attention.onInspectHistory
                  ? {
                      label: "Inspect History",
                      onAction: attention.onInspectHistory,
                    }
                  : undefined
              }
            />
          )}
          {row.refineReason !== undefined &&
          refineWaiverProject !== undefined ? (
            <RefineGateWaiver
              projectPath={refineWaiverProject}
              reason={row.refineReason}
              waived={waivedIds.has(row.id)}
              onWaived={() =>
                onWaived(
                  rows
                    .filter((other) => other.refineReason !== undefined)
                    .map((other) => other.id),
                )
              }
            />
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function ReviewQueue({
  items,
  content,
  selectedId,
  filter,
  speaker = null,
  sort = "kind",
  job,
  bulkRunning,
  guest = false,
  canDecide = !guest,
  state = "ready",
  detailKind,
  attention,
  onFilter,
  onSpeaker,
  onSort,
  onSelect,
  onPlayComment,
  onVerb,
  onKeep,
  onBulk,
  onBulkIds,
  onFindMore,
  findMoreDisabled,
  onRetry,
}: ReviewQueueProps) {
  const [showDecided, setShowDecided] = useState(false);
  const [waived, setWaived] = useState<ReadonlySet<string>>(() => new Set());
  const completeness = reviewCompletenessOf(items, detailKind, speaker);
  const { counts } = completeness;
  const shown = filterItems(items, filter, speaker);
  const people = canDecide && onSpeaker ? speakersOf(items) : [];
  // With one kind of item the grouping has nothing to separate, so a
  // comments-only queue (no bulk verbs on the groups) lists by time.
  const oneKind = new Set(items.map((item) => item.kind)).size <= 1;
  const timeOnly = !canDecide && oneKind;
  const sortable = !!onSort && (canDecide || !oneKind);
  const byTime = sort === "time" || timeOnly;
  const groups = byTime ? [] : groupQueue(shown);
  const inTime = byTime ? timeQueue(shown) : [];
  const lowRisk = canDecide && !bulkRunning ? lowRiskBulk(shown) : null;
  const lowRiskLabel = lowRisk
    ? `Cut ${lowRisk.ids.length} clean ${lowRisk.ids.length === 1 ? "edit" : "edits"}`
    : "";
  const decided = decidedItems(shown);
  // The group has left the queue; the row follows the filter that showed it.
  const cuttingAlone =
    !!bulkRunning &&
    kindInFilter(bulkRunning.kind, filter) &&
    !groups.some((g) => g.kind === bulkRunning.kind);
  const showAttention = attentionVisible(attention, filter);
  const listed = new Set(attention?.rows.map((row) => row.id));
  if ([...waived].some((id) => !listed.has(id)))
    setWaived(new Set([...waived].filter((id) => listed.has(id))));
  const attentionFocused = useRef(false);
  const progressRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (showAttention || !attentionFocused.current) return;
    attentionFocused.current = false;
    progressRef.current?.focus();
  }, [showAttention]);
  const filters = FILTERS.filter(({ id }) =>
    id === "checks" ? canDecide && !guest : canDecide || id !== "suggestions",
  );
  // A guest queue with one kind of item has nothing to filter, sort, group or
  // count aloud; with two or more kinds it keeps all four, as a host's does.
  const showFilter = canDecide || !oneKind || filter !== "all";
  // Only a host resolves, so a guest's count of resolved comments shows once the
  // host has resolved one; until then the line is a screen-reader anchor.
  const resolvedSome = items.some((item) => item.result !== undefined);
  const quietLine = !canDecide && oneKind && !resolvedSome;
  const statusLine = canDecide
    ? (completeness.unavailableMessage ?? progressLine(items))
    : resolvedSome || !oneKind
      ? commentLine(items)
      : `${items.length} ${items.length === 1 ? "comment" : "comments"}`;
  const reason = useDisabledReasonNote(guest ? undefined : findMoreDisabled);

  if (state !== "ready") {
    return (
      <section className="rv-queue" aria-label="Review queue">
        {state === "loading" ? (
          <Skeleton layout="list" rows={6} />
        ) : (
          <StatusRow
            state="failed"
            title="Could not load the queue"
            detail="Your decisions are saved."
            action={
              onRetry ? { label: "Try again", onAction: onRetry } : undefined
            }
          />
        )}
      </section>
    );
  }

  const progress = (
    <p
      ref={progressRef}
      tabIndex={-1}
      className={
        quietLine ? "rv-progress sys-mono sr-only" : "rv-progress sys-mono"
      }
      aria-live="polite"
    >
      {statusLine}
    </p>
  );
  const hasControls =
    showFilter || !guest || sortable || (people.length > 0 && !!onSpeaker);
  const controls = (
    <>
      {showFilter || !guest ? (
        <div className="rv-filter">
          {showFilter ? (
            <SegmentedControl label="Filter" className="rv-kind-filter">
              {filters.map(({ id, label, icon }) => (
                <ToggleButton
                  key={id}
                  quiet
                  pressed={filter === id}
                  aria-label={`${label}, ${counts[id] ?? "count unavailable"}`}
                  title={label}
                  onClick={() => onFilter(id)}
                >
                  {icon}
                  <span>{label}</span>{" "}
                  <span className="sys-mono">{counts[id] ?? "—"}</span>
                </ToggleButton>
              ))}
            </SegmentedControl>
          ) : null}
          {guest ? null : (
            <VerbButton
              verb="propose"
              label="Find more"
              onClick={onFindMore}
              {...disabledAttrs(findMoreDisabled)}
              {...reason.describedBy}
            />
          )}
        </div>
      ) : null}
      {sortable ? (
        <div className="rv-filter rv-sort">
          <SegmentedControl label="Sort">
            <ToggleButton
              quiet
              pressed={!byTime}
              onClick={() => onSort?.("kind")}
            >
              <span>By kind</span>
            </ToggleButton>
            <ToggleButton
              quiet
              pressed={byTime}
              onClick={() => onSort?.("time")}
            >
              <span>By time</span>
            </ToggleButton>
          </SegmentedControl>
        </div>
      ) : null}
      {people.length > 0 && onSpeaker ? (
        <div className="rv-filter rv-speakers">
          <SegmentedControl label="Speaker">
            <ToggleButton
              quiet
              pressed={speaker === null}
              onClick={() => onSpeaker(null)}
            >
              <span>Everyone</span>
            </ToggleButton>
            {people.map((chip) => (
              <ToggleButton
                key={chip.id}
                quiet
                pressed={speaker === chip.id}
                aria-label={`${chip.label}, ${completeness.wordsKnown ? chip.open : "count unavailable"}`}
                title={chip.label}
                onClick={() => onSpeaker(chip.id)}
              >
                <span>{chip.label}</span>
                <span className="sys-mono">
                  {completeness.wordsKnown ? chip.open : "—"}
                </span>
              </ToggleButton>
            ))}
          </SegmentedControl>
        </div>
      ) : null}
    </>
  );
  // With nothing to show above the rows, only the screen-reader line stays, and
  // outside the header so it takes no height.
  const header = hasControls ? (
    <header className="rv-head">
      {progress}
      {controls}
    </header>
  ) : (
    progress
  );

  const activate = (item: ReviewItem) => {
    onSelect(item.id);
    if (item.kind === "comment") onPlayComment?.(item.id);
  };

  const renderItem = (item: ReviewItem, running?: BulkProgress) => {
    const { row, check, card } = content(item);
    const selected = item.id === selectedId;
    const unavailableWord =
      item.kind === "unsure-word" && !!card.unsure?.disabledReason;
    if (check) {
      return (
        <div
          key={item.id}
          className="rv-check"
          data-selected={selected || undefined}
        >
          <StatusRow
            state="needs-you"
            title={check.title}
            detail={check.detail}
            action={{
              label: check.actionLabel,
              onAction: () => onSelect(item.id),
            }}
          />
        </div>
      );
    }
    return (
      <QueueRow
        key={item.id}
        kind={item.kind}
        {...row}
        selected={selected}
        onSelect={() => activate(item)}
        onVerb={
          !canDecide ||
          unavailableWord ||
          running ||
          item.blocked ||
          (guest && item.kind === "comment")
            ? undefined
            : () => onVerb?.(item.id)
        }
        onKeep={
          !canDecide ||
          unavailableWord ||
          running ||
          (guest && item.kind === "comment")
            ? undefined
            : () => onKeep?.(item.id)
        }
      />
    );
  };

  return (
    <section className="rv-queue" aria-label="Review queue">
      {header}
      {reason.note}
      {job?.needs ? (
        <ModelNeedRow model={job.needs} />
      ) : job?.error ? (
        <StatusRow
          state="failed"
          density="alert"
          title="Could not find more suggestions"
          details={job.error}
          action={
            onFindMore && !findMoreDisabled
              ? { label: "Try again", onAction: onFindMore }
              : undefined
          }
        />
      ) : job ? (
        <StatusRow
          state="running"
          density="alert"
          title={job.title}
          detail={
            job.progress === undefined
              ? undefined
              : `${Math.round(job.progress * 100)}%`
          }
          progress={job.progress}
        />
      ) : null}
      {showAttention ? (
        <AttentionGroup
          attention={attention}
          waivedIds={waived}
          onWaived={(ids) => setWaived(new Set(ids))}
          onFocusChange={(inside) => {
            attentionFocused.current = inside;
          }}
          onVanished={() => {
            if (focusFellBack(document.activeElement))
              progressRef.current?.focus();
          }}
        />
      ) : null}
      {lowRisk ? (
        <section className="rv-group" aria-label="Low-risk edits">
          <div className="rv-group-head">
            <SystemIcon name={iconOf("approve")} size={16} />
            <span className="rv-group-name">Low risk</span>
            <span className="sys-mono rv-group-count">
              {lowRisk.ids.length}
            </span>
            <span className="sys-mono">
              {formatSeconds(lowRisk.savedSeconds)}
            </span>
            <Button
              className="rv-bulk"
              onClick={() => onBulkIds?.(lowRisk.ids)}
              title={`${lowRiskLabel}${hintOf(verbOf("applyAll"))}`}
            >
              <SystemIcon name={iconOf("approve")} size={14} />
              {lowRiskLabel}
            </Button>
          </div>
        </section>
      ) : null}
      {cuttingAlone ? (
        <section className="rv-group" aria-label="Cutting" aria-busy>
          <BulkRow running={bulkRunning} />
        </section>
      ) : null}
      {groups.length === 0 &&
      inTime.length === 0 &&
      !cuttingAlone &&
      !showAttention ? (
        <EmptyState as="div" role="status">
          {counts[filter] === null
            ? completeness.unavailableMessage
            : filter !== "all"
              ? "Nothing here"
              : !canDecide
                ? "No comments yet"
                : "Nothing to decide"}
        </EmptyState>
      ) : null}
      {groups.map((group) => {
        const running =
          bulkRunning?.kind === group.kind ? bulkRunning : undefined;
        return (
          <section
            key={group.label}
            className="rv-group"
            aria-label={group.label}
            aria-busy={running ? true : undefined}
          >
            <GroupHeader
              group={group}
              running={running}
              canDecide={canDecide}
              onBulk={onBulk}
              count={reviewSubsetCount(
                group.items.length,
                detailKind,
                group.kind === "unsure-word",
              )}
            />
            {group.items.map((item) => renderItem(item, running))}
          </section>
        );
      })}
      {inTime.length > 0 ? (
        <section className="rv-group" aria-label="In time order">
          {timeOnly ? null : (
            <div className="rv-group-head">
              <SystemIcon name="clock" size={16} />
              <span className="rv-group-name">In time order</span>
              <span className="sys-mono rv-group-count">
                {counts[filter] ?? "Count unavailable"}
              </span>
            </div>
          )}
          {inTime.map((item) => renderItem(item))}
        </section>
      ) : null}
      {decided.length > 0 ? (
        <section className="rv-group" aria-label="Decided">
          <button
            type="button"
            className="rv-decided-toggle"
            aria-expanded={showDecided}
            onClick={() => setShowDecided(!showDecided)}
          >
            <SystemIcon name="chevron-down" size={14} />
            Decided
            <span className="sys-mono">{decided.length}</span>
          </button>
          {showDecided
            ? decided.map((item) => (
                <QueueRow
                  key={item.id}
                  kind={item.kind}
                  {...content(item).row}
                  decided={{
                    result: item.result ?? "kept",
                    text: resultText(item),
                  }}
                  selected={item.id === selectedId}
                  onSelect={
                    item.kind === "comment" ? () => activate(item) : undefined
                  }
                />
              ))
            : null}
        </section>
      ) : null}
    </section>
  );
}
