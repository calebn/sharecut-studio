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
} from "./reviewQueue";

export type ReviewContent = {
  row: Pick<
    QueueRowProps,
    "snippet" | "time" | "value" | "author" | "unread" | "offline"
  >;
  /** A Check item draws as a Status row instead of a queue row. */
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
  > & { unsure?: { word: string; guess: string } };
};

export type BulkProgress = { kind: DecisionKind; total: number; done: number };

export type ReviewQueueProps = {
  items: readonly ReviewItem[];
  content: (item: ReviewItem) => ReviewContent;
  selectedId: string | null;
  filter: ReviewFilter;
  /** Prepare is still finding suggestions: a running row above the groups. */
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

const GERUND: Partial<Record<string, string>> = {
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
  return (
    <div className="rv-group-head">
      <SystemIcon name={meta.icon} size={16} />
      <span className="rv-group-name">{group.label}</span>
      <span className="sys-mono rv-group-count">{group.items.length}</span>
      {group.savedSeconds > 0 ? (
        <span className="sys-mono rv-group-saved">
          {formatSeconds(group.savedSeconds)}
        </span>
      ) : null}
      {bulk && verb?.icon ? (
        <Button
          className="rv-bulk"
          onClick={() => onBulk?.(group)}
          title={`${verb.label} all ${bulk.ids.length}${hintOf(verbOf("applyAll"))}`}
        >
          <SystemIcon name={verb.icon} size={14} />
          {verb.label} all {bulk.ids.length}
        </Button>
      ) : null}
    </div>
  );
}

/** Groups by kind, each with its bulk verb, then a collapsed Decided group. */
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

  if (state === "loading") {
    return (
      <section className="rv-queue" aria-label="Review queue">
        <Skeleton layout="list" rows={6} />
      </section>
    );
  }
  if (state === "error") {
    return (
      <section className="rv-queue" aria-label="Review queue">
        <StatusRow
          state="failed"
          title="Could not load the queue"
          detail="Your decisions are saved."
          action={
            onRetry ? { label: "Try again", onAction: onRetry } : undefined
          }
        />
      </section>
    );
  }

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
                    guest || running ? undefined : () => onVerb?.(item.id)
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
