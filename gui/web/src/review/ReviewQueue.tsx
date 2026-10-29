import { type ReactNode, useState } from "react";
import type { DecisionCardProps } from "../system/DecisionCard";
import { type DecisionKind, KIND_META } from "../system/decisionKinds";
import { QueueRow, type QueueRowProps } from "../system/QueueRow";
import { Skeleton } from "../system/Skeleton";
import { StatusRow } from "../system/StatusRow";
import { SystemIcon } from "../system/SystemIcon";
import { formatSeconds } from "../system/seconds";
import { VerbButton } from "../system/VerbButton";
import { hintOf, iconOf, verbOf } from "../system/verbDisplay";
import type { VerbId } from "../system/verbs";
import { Button, EmptyState, SegmentedControl, ToggleButton } from "../ui";
import {
  decidedItems,
  filterCounts,
  filterItems,
  groupQueue,
  progressLine,
  type ReviewFilter,
  type ReviewGroup,
  type ReviewItem,
  resultText,
} from "./reviewQueueModel";

export type ReviewContent = {
  row: Pick<
    QueueRowProps,
    "snippet" | "time" | "value" | "author" | "unread" | "offline"
  >;
  check?: { title: string; detail?: string; actionLabel: string };
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
      id?: string;
      step?: { index: number; total: number };
    };
  };
};

export type BulkProgress = { kind: DecisionKind; total: number; done: number };

export type ReviewQueueProps = {
  items: readonly ReviewItem[];
  content: (item: ReviewItem) => ReviewContent;
  selectedId: string | null;
  filter: ReviewFilter;
  /** The Prepare job still finding suggestions. */
  job?: { title: string; progress: number };
  bulkRunning?: BulkProgress;
  /** A guest reads the queue: no bulk verbs, no Find more, no swipes. */
  guest?: boolean;
  state?: "ready" | "loading" | "error";
  onFilter: (filter: ReviewFilter) => void;
  onSelect: (id: string) => void;
  onVerb?: (id: string) => void;
  onKeep?: (id: string) => void;
  onBulk?: (group: ReviewGroup) => void;
  onFindMore?: () => void;
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

function GroupHeader({
  group,
  running,
  guest,
  onBulk,
}: {
  group: ReviewGroup;
  running?: BulkProgress;
  guest: boolean;
  onBulk?: (group: ReviewGroup) => void;
}) {
  const meta = KIND_META[group.kind];
  if (running) {
    const verb = verbOf(meta.verb);
    return (
      <StatusRow
        state="running"
        density="inline"
        title={`${GERUND[meta.verb] ?? verb.label} ${running.total}`}
        detail={`${running.done} done`}
        progress={running.done / running.total}
      />
    );
  }
  const bulk = guest ? null : group.bulk;
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
      <span className="sys-mono rv-group-count">{group.items.length}</span>
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
      {group.held > 0 && !guest ? (
        <span id={heldId} className="sys-mono">
          {group.held} to decide one by one
        </span>
      ) : null}
    </div>
  );
}

export function ReviewQueue({
  items,
  content,
  selectedId,
  filter,
  job,
  bulkRunning,
  guest = false,
  state = "ready",
  onFilter,
  onSelect,
  onVerb,
  onKeep,
  onBulk,
  onFindMore,
  onRetry,
}: ReviewQueueProps) {
  const [showDecided, setShowDecided] = useState(false);
  const counts = filterCounts(items);
  const shown = filterItems(items, filter);
  const groups = groupQueue(shown);
  const decided = decidedItems(shown);

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

  const header = (
    <header className="rv-head">
      <p className="rv-progress sys-mono" aria-live="polite">
        {progressLine(items)}
      </p>
      <div className="rv-filter">
        <SegmentedControl label="Filter">
          {FILTERS.map(({ id, label, icon }) => (
            <ToggleButton
              key={id}
              quiet
              pressed={filter === id}
              aria-label={`${label}, ${counts[id]}`}
              title={label}
              onClick={() => onFilter(id)}
            >
              {icon}
              <span className="sys-mono">
                {id === "all" ? `All ${counts.all}` : counts[id]}
              </span>
            </ToggleButton>
          ))}
        </SegmentedControl>
        {guest ? null : (
          <VerbButton verb="propose" label="Find more" onClick={onFindMore} />
        )}
      </div>
    </header>
  );

  return (
    <section className="rv-queue" aria-label="Review queue">
      {header}
      {job ? (
        <StatusRow
          state="running"
          density="alert"
          title={job.title}
          detail={`${Math.round(job.progress * 100)}%`}
          progress={job.progress}
        />
      ) : null}
      {groups.length === 0 ? (
        <EmptyState as="div" role="status">
          {filter === "all" ? "Nothing to decide" : "Nothing here"}
        </EmptyState>
      ) : null}
      {groups.map((group) => {
        const running =
          bulkRunning?.kind === group.kind ? bulkRunning : undefined;
        return (
          <section
            key={group.kind}
            className="rv-group"
            aria-label={group.label}
            aria-busy={running ? true : undefined}
          >
            <GroupHeader
              group={group}
              running={running}
              guest={guest}
              onBulk={onBulk}
            />
            {group.items.map((item) => {
              const { row, check } = content(item);
              const selected = item.id === selectedId;
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
                  onSelect={() => onSelect(item.id)}
                  onVerb={
                    guest || running || item.blocked
                      ? undefined
                      : () => onVerb?.(item.id)
                  }
                  onKeep={
                    guest || running ? undefined : () => onKeep?.(item.id)
                  }
                />
              );
            })}
          </section>
        );
      })}
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
                />
              ))
            : null}
        </section>
      ) : null}
    </section>
  );
}
