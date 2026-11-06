import { useAfter } from "../../hooks/useAfter";
import { useViewportClass } from "../../hooks/useViewportClass";
import type { ShellBreakpoint } from "../../state/types";
import { StageBar } from "../../system/StageBar";
import { stageLabel } from "../../system/verbs";
import type { StageId } from "../../types/stage";
import { Button } from "../../ui";
import { STAGE_BODY_ID, StageFrameView } from "./StageFrameView";

export const LOADING_BLANK_MS = 300;
/** "Still loading…" and Retry appear under the body at this time. */
export const LOADING_SLOW_MS = 4000;

const LOADING_STATUS = "Loading the project";

type Phase = "blank" | "bar" | "slow";

const phaseOf = (elapsed: number): Phase =>
  elapsed >= LOADING_SLOW_MS
    ? "slow"
    : elapsed >= LOADING_BLANK_MS
      ? "bar"
      : "blank";

const BODY: Record<StageId, readonly { id: string; kind: string }[]> = {
  record: [
    { id: "record-wide", kind: "wide" },
    { id: "record-strip-primary", kind: "strip" },
    { id: "record-strip-secondary", kind: "strip" },
  ],
  prepare: [
    { id: "prepare-row-track", kind: "row" },
    { id: "prepare-row-tools", kind: "row" },
    { id: "prepare-row-options", kind: "row" },
    { id: "prepare-side-panel", kind: "side" },
  ],
  edit: [
    { id: "edit-ruler", kind: "ruler" },
    { id: "edit-lane-primary", kind: "lane" },
    { id: "edit-lane-secondary", kind: "lane" },
    { id: "edit-lane-tertiary", kind: "lane" },
    { id: "edit-side-panel", kind: "side" },
  ],
  review: [
    { id: "review-row-overview", kind: "row" },
    { id: "review-row-comments", kind: "row" },
    { id: "review-row-timeline", kind: "row" },
    { id: "review-row-actions", kind: "row" },
    { id: "review-row-notes", kind: "row" },
  ],
  deliver: [
    { id: "deliver-card-export", kind: "card" },
    { id: "deliver-card-feed", kind: "card" },
    { id: "deliver-card-share", kind: "card" },
  ],
};

export type StageLoadingProps = {
  stage: StageId;
  name?: string;
  /** Fixes the shell (stories); otherwise the viewport decides. */
  shell?: ShellBreakpoint;
  /** Fixes the elapsed time (stories, tests). Without it the timers run. */
  elapsedMs?: number;
  onRetry: () => void;
};

function useElapsedPhase(elapsedMs: number | undefined): Phase {
  const controlled = elapsedMs !== undefined;
  const bar = useAfter(controlled ? null : LOADING_BLANK_MS);
  const slow = useAfter(controlled ? null : LOADING_SLOW_MS);
  if (controlled) return phaseOf(elapsedMs);
  return slow ? "slow" : bar ? "bar" : "blank";
}

/**
 * The Loading cover: nothing for 300 ms, then the Stage bar for real and static
 * grey placeholders in the destination stage's layout, and after 4 s one line
 * with Retry. No spinner and no visible "Loading"; a hidden status line tells a screen reader.
 */
export function StageLoading({
  stage,
  name,
  shell: shellProp,
  elapsedMs,
  onRetry,
}: StageLoadingProps) {
  const viewport = useViewportClass();
  const shell = shellProp ?? viewport;
  const phase = useElapsedPhase(elapsedMs);
  if (phase === "blank") {
    return <div className="stage-loading-blank" aria-busy="true" />;
  }
  const bar = (form: "bar" | "tabs") => (
    <div className="stage-loading-stages" inert>
      <StageBar
        active={stage}
        form={form}
        onSelect={noop}
        panelId={STAGE_BODY_ID}
      />
    </div>
  );
  return (
    <StageFrameView
      shell={shell}
      stage={stage}
      stageLabel={stageLabel(stage)}
      header={
        <header className="stage-loading-head">
          <span className="stage-loading-name">{name}</span>
          {shell === "phone" ? null : (
            <div className="stage-loading-bar">{bar("bar")}</div>
          )}
        </header>
      }
      tabs={shell === "phone" ? bar("tabs") : null}
    >
      <div className={`stage-loading-body stage-loading-body--${stage}`}>
        <p className="sr-only" role="status">
          {LOADING_STATUS}
        </p>
        <div className="stage-loading-blocks" aria-hidden="true">
          {BODY[stage].map(({ id, kind }) => (
            <span
              key={id}
              className={`sys-skeleton-block stage-loading-block stage-loading-block--${kind}`}
            />
          ))}
        </div>
        {phase === "slow" ? (
          <p className="stage-loading-slow" role="status">
            <span>Still loading…</span>
            <Button onClick={onRetry}>Retry</Button>
          </p>
        ) : null}
      </div>
    </StageFrameView>
  );
}

function noop() {}
