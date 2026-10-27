import { type ReactNode, useId, useRef, useState } from "react";
import { DropOverlay } from "../../system/DropOverlay";
import { StageHandoff } from "../../system/StageHandoff";
import { StartTile } from "../../system/StartTile";
import { StatusGlyph } from "../../system/StatusGlyph";
import type { StatusRowState } from "../../system/StatusRow";
import { SystemIcon } from "../../system/SystemIcon";
import { useFocusRescue } from "../../system/useFocusRescue";
import { Button, SegmentedControl, ToggleButton } from "../../ui";
import { type PreparePhase, useAnnouncement } from "./prepareAnnouncement";
import type { PrepareSession, SourceActions } from "./prepareTypes";
import {
  type ReadyAction,
  ReadyList,
  type ReadyRowData,
  type ReadyRowId,
} from "./ReadyList";
import { SessionSources } from "./SessionSources";
import { Vocabulary } from "./Vocabulary";

export type CleanupSettings = {
  tight: "light" | "medium" | "tight";
  loudness: "podcast" | "broadcast" | "streaming";
};

const TIGHT: readonly { id: CleanupSettings["tight"]; label: string }[] = [
  { id: "light", label: "Light" },
  { id: "medium", label: "Medium" },
  { id: "tight", label: "Tight" },
];

const LOUDNESS: readonly {
  id: CleanupSettings["loudness"];
  label: string;
  level: string;
}[] = [
  { id: "podcast", label: "Podcast", level: "−16" },
  { id: "broadcast", label: "Broadcast", level: "−23" },
  { id: "streaming", label: "Streaming", level: "−14" },
];

export type PrepareViewProps = {
  phase: PreparePhase;
  sessions: readonly PrepareSession[];
  rows: readonly ReadyRowData[];
  /** The phone's collapsed line: "Transcribing 2 of 3". */
  readySummary: string;
  /** Names and terms. The speakers come from the named Source cards. */
  terms?: readonly string[];
  onTermsChange?: (terms: string[]) => void;
  /** Transcription has run, so a new term needs another pass. */
  needsRetranscribe?: boolean;
  onRetranscribe?: () => void;
  /** Replaces the vocabulary field; a plain line stands in when nothing is given. */
  vocabulary?: ReactNode;
  cleanup: CleanupSettings;
  onCleanup: (next: CleanupSettings) => void;
  /** The one hand-off. `disabledReason` while the work is not done. */
  handoff: { label: string; disabledReason?: string };
  /** Files being added, for the live region. */
  addCount?: number;
  dropActive?: boolean;
  /** Files dragged over the window; left out when the browser will not say. */
  dropCount?: number;
  failure?: { step: string; cause: string };
  sourceActions: SourceActions;
  onTarget?: (sessionId: string, target: PrepareSession["target"]) => void;
  onImport: () => void;
  onRecord: () => void;
  onAdvanced: () => void;
  onRowAction: (row: ReadyRowId, action: ReadyAction) => void;
  onHandoff: () => void;
};

/** The worst state among the rows, for the phone's one-line summary. */
function summaryState(rows: readonly ReadyRowData[]): StatusRowState {
  for (const state of ["failed", "needs-you", "running"] as const) {
    if (rows.some((row) => row.state === state)) return state;
  }
  return rows.every((row) => row.state === "done") ? "done" : "queued";
}

const GLYPH = {
  queued: "not-yet",
  running: "running",
  done: "done",
  "needs-you": "needs-you",
  failed: "failed",
} as const;

function dropLabel(count: number | undefined): string {
  return count === undefined
    ? "Drop to add audio"
    : `Drop to add ${count} ${count === 1 ? "file" : "files"}`;
}

/**
 * The Prepare stage: Getting ready, Sources, Help the transcriber and
 * Cleanup, then the one hand-off. A stage inside the shell, so a plain div
 * with h2 sections: the shell owns main and the page heading. The DOM order is
 * Sources, Getting ready, Help the transcriber, Cleanup, hand-off, so Tab
 * follows the desktop columns. On a phone Getting ready is shown first with
 * CSS `order`, the one place the reading order differs. One polite status line speaks the phase when it
 * changes, never a progress tick.
 */
export function PrepareView({
  phase,
  sessions,
  rows,
  readySummary,
  terms,
  onTermsChange,
  needsRetranscribe,
  onRetranscribe,
  vocabulary,
  cleanup,
  onCleanup,
  handoff,
  addCount,
  dropActive = false,
  dropCount,
  failure,
  sourceActions,
  onTarget,
  onImport,
  onRecord,
  onAdvanced,
  onRowAction,
  onHandoff,
}: PrepareViewProps) {
  // On a phone the rows fold behind the summary, but a row that needs you or
  // failed has a button the person must reach, so the summary opens when one
  // is there at the start or turns up later. Closing it by hand sticks until
  // another row needs attention.
  const attention = rows
    .filter((row) => row.state === "failed" || row.state === "needs-you")
    .map((row) => row.id);
  const [readyOpen, setReadyOpen] = useState(attention.length > 0);
  const [seen, setSeen] = useState(attention);
  if (attention.join() !== seen.join()) {
    setSeen(attention);
    if (attention.some((id) => !seen.includes(id))) setReadyOpen(true);
  }
  const root = useRef<HTMLDivElement>(null);
  useFocusRescue(root, (target) => {
    const near = (items: HTMLElement[], at: number) =>
      items.slice(at + 1).find((item) => item.isConnected) ??
      items
        .slice(0, at)
        .reverse()
        .find((item) => item.isConnected);
    const all = (selector: string) => [
      ...(root.current?.querySelectorAll<HTMLElement>(selector) ?? []),
    ];
    const cards = all(".sys-source");
    const groups = all(".sys-group");
    const card = cards.findIndex((one) => one.contains(target));
    const group = groups.findIndex((one) => one.contains(target));
    const items = card >= 0 ? cards : groups;
    const at = card >= 0 ? card : group;
    if (at < 0) return () => null;
    return () =>
      near(items, at) ??
      root.current?.querySelector<HTMLElement>(".sys-start--import");
  });
  const ids = {
    sources: useId(),
    ready: useId(),
    readyBody: useId(),
    help: useId(),
    cleanup: useId(),
  };
  const announcement = useAnnouncement({
    phase,
    addCount,
    dropCount,
    dropActive,
    handoffLabel: handoff.label,
    failure,
  });
  const tileState = dropActive ? "drag-hover" : "rest";
  const status = (
    <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {announcement}
    </p>
  );
  const overlay = dropActive ? (
    <DropOverlay label={dropLabel(dropCount)} />
  ) : null;

  if (phase === "empty") {
    return (
      <div ref={root} className="sys-prepare" data-phase="empty">
        <div className="sys-prepare-layout">
          <section className="sys-prepare-empty" aria-labelledby={ids.sources}>
            <h2 id={ids.sources} className="sr-only">
              Sources
            </h2>
            <StartTile
              kind="import"
              size={240}
              state={tileState}
              dragCount={dropCount}
              onActivate={onImport}
            />
            <StartTile kind="record" size={240} onActivate={onRecord} />
          </section>
        </div>
        {overlay}
        {status}
      </div>
    );
  }

  const firstIndexes = sessions.map(
    (_, at) =>
      1 +
      sessions
        .slice(0, at)
        .reduce((sum, earlier) => sum + earlier.sources.length, 0),
  );
  const state = summaryState(rows);
  const speakers = [
    ...new Map(
      sessions
        .flatMap((one) => one.sources.map((source) => source.name.trim()))
        .filter(Boolean)
        .map((name) => [name.toLowerCase(), name] as const),
    ).values(),
  ];
  const counts = new Map<string, number>();
  for (const one of sessions) {
    for (const source of one.sources) {
      const key = source.name.trim().toLowerCase();
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const repeated = new Set(
    [...counts].filter(([, count]) => count > 1).map(([key]) => key),
  );
  return (
    <div ref={root} className="sys-prepare" data-phase={phase}>
      <div className="sys-prepare-layout">
        <section className="sys-prepare-sources" aria-labelledby={ids.sources}>
          <h2 id={ids.sources} className="sys-prepare-title">
            Sources
          </h2>
          <div className="sys-start-pair">
            <StartTile
              kind="import"
              size={80}
              state={tileState}
              dragCount={dropCount}
              onActivate={onImport}
            />
            <StartTile kind="record" size={80} onActivate={onRecord} />
          </div>
          {sessions.map((session, at) => {
            return (
              <SessionSources
                key={session.id}
                session={session}
                firstIndex={firstIndexes[at]}
                repeated={repeated}
                actions={sourceActions}
                onTarget={
                  onTarget ? (to) => onTarget(session.id, to) : undefined
                }
              />
            );
          })}
        </section>
        <section className="sys-prepare-ready" aria-labelledby={ids.ready}>
          <div className="sys-prepare-head">
            <h2 id={ids.ready} className="sys-prepare-title">
              Getting ready
            </h2>
            <Button onClick={onAdvanced}>
              <SystemIcon name="settings" size={14} />
              Advanced
            </Button>
          </div>
          <button
            type="button"
            className="sys-prepare-summary"
            aria-expanded={readyOpen}
            aria-controls={ids.readyBody}
            onClick={() => setReadyOpen((open) => !open)}
          >
            <StatusGlyph state={GLYPH[state]} />
            <span className="sys-prepare-summary-text">{readySummary}</span>
            <span className="sys-prepare-chevron">
              <SystemIcon name="chevron-down" size={16} />
            </span>
          </button>
          <div
            id={ids.readyBody}
            className="sys-prepare-ready-body"
            data-open={readyOpen}
          >
            <ReadyList rows={rows} onAction={onRowAction} />
          </div>
        </section>
        <section className="sys-prepare-aside" aria-labelledby={ids.help}>
          <h2 id={ids.help} className="sys-prepare-title">
            Help the transcriber
          </h2>
          {vocabulary ??
            (terms && onTermsChange ? (
              <Vocabulary
                heading={false}
                speakers={speakers}
                terms={terms}
                onTermsChange={onTermsChange}
                needsRetranscribe={needsRetranscribe}
                onRetranscribe={onRetranscribe}
              />
            ) : (
              <p className="sys-prepare-note">
                Speaker names from Sources are shared with the transcriber.
              </p>
            ))}
          <h3 id={ids.cleanup} className="sys-prepare-subtitle">
            Cleanup
          </h3>
          <div
            className="sys-prepare-field"
            role="group"
            aria-labelledby={ids.cleanup}
          >
            <p className="sys-prepare-label" aria-hidden="true">
              How tight
            </p>
            <SegmentedControl label="How tight">
              {TIGHT.map((option) => (
                <ToggleButton
                  key={option.id}
                  quiet
                  pressed={cleanup.tight === option.id}
                  onClick={() => onCleanup({ ...cleanup, tight: option.id })}
                >
                  {option.label}
                </ToggleButton>
              ))}
            </SegmentedControl>
            <p className="sys-prepare-label" aria-hidden="true">
              Loudness
            </p>
            <SegmentedControl label="Loudness">
              {LOUDNESS.map((option) => (
                <ToggleButton
                  key={option.id}
                  quiet
                  pressed={cleanup.loudness === option.id}
                  onClick={() => onCleanup({ ...cleanup, loudness: option.id })}
                >
                  {option.label} {option.level}
                  <span className="sr-only"> LUFS</span>
                </ToggleButton>
              ))}
            </SegmentedControl>
          </div>
        </section>
        <div className="sys-prepare-handoff">
          <StageHandoff
            stage="review"
            label={handoff.label}
            variant={phase === "done" ? "primary" : "secondary"}
            size={40}
            disabledReason={handoff.disabledReason}
            onActivate={onHandoff}
          />
        </div>
      </div>
      {overlay}
      {status}
    </div>
  );
}
