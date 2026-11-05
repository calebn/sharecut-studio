import { useEffect, useState } from "react";
import { useViewportClass } from "../../hooks/useViewportClass";
import type { ShellBreakpoint } from "../../state/types";
import { StageBar } from "../../system/StageBar";
import type { StageId } from "../../types/stage";
import { Button } from "../../ui";
import { STAGE_BODY_ID, StageFrameView } from "./StageFrameView";

/** Nothing is drawn before this. */
export const LOADING_BLANK_MS = 300;
/** "Still loading. Try again" appears under the body at this time. */
export const LOADING_SLOW_MS = 8000;

type Phase = "blank" | "bar" | "slow";

const phaseOf = (elapsed: number): Phase =>
  elapsed >= LOADING_SLOW_MS
    ? "slow"
    : elapsed >= LOADING_BLANK_MS
      ? "bar"
      : "blank";

/** The blocks of each stage's body, in that stage's real layout. */
const BODY: Record<StageId, readonly string[]> = {
  record: ["wide", "strip", "strip"],
  prepare: ["row", "row", "row", "side"],
  edit: ["ruler", "lane", "lane", "lane", "side"],
  review: ["row", "row", "row", "row", "row"],
  deliver: ["card", "card", "card"],
};

const STAGE_NAME: Record<StageId, string> = {
  record: "Record",
  prepare: "Prepare",
  edit: "Edit",
  review: "Review",
  deliver: "Deliver",
};

export type StageLoadingProps = {
  /** The stage the project opens on. */
  stage: StageId;
  /** The project's name, when the URL or the Home card gave it. */
  name?: string;
  /** Fixes the shell (stories); otherwise the viewport decides. */
  shell?: ShellBreakpoint;
  /** Fixes the elapsed time (stories, tests). Without it the timers run. */
  elapsedMs?: number;
  onRetry: () => void;
};

function useElapsedPhase(elapsedMs: number | undefined): Phase {
  const [timed, setTimed] = useState<Phase>("blank");
  const controlled = elapsedMs !== undefined;
  useEffect(() => {
    if (controlled) return;
    const bar = window.setTimeout(() => setTimed("bar"), LOADING_BLANK_MS);
    const slow = window.setTimeout(() => setTimed("slow"), LOADING_SLOW_MS);
    return () => {
      window.clearTimeout(bar);
      window.clearTimeout(slow);
    };
  }, [controlled]);
  return controlled ? phaseOf(elapsedMs) : timed;
}

/**
 * The Loading cover: nothing for 300 ms, then the Stage bar for real and static
 * grey placeholders in the destination stage's layout, and after 8 s one line
 * with Try again. No spinner and no text that says "Loading".
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
    <StageBar
      active={stage}
      form={form}
      onSelect={noop}
      panelId={STAGE_BODY_ID}
    />
  );
  return (
    <StageFrameView
      shell={shell}
      stage={stage}
      stageLabel={STAGE_NAME[stage]}
      header={
        <div className="stage-loading-head">
          <span className="stage-loading-name">{name}</span>
          {shell === "phone" ? null : (
            <div className="stage-loading-bar">{bar("bar")}</div>
          )}
        </div>
      }
      tabs={shell === "phone" ? bar("tabs") : null}
    >
      <div
        className={`stage-loading-body stage-loading-body--${stage}`}
        aria-busy="true"
      >
        <div className="stage-loading-blocks" aria-hidden="true">
          {BODY[stage].map((kind, index) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
              key={index}
              className={`sys-skeleton-block stage-loading-block stage-loading-block--${kind}`}
            />
          ))}
        </div>
        {phase === "slow" ? (
          <p className="stage-loading-slow" role="status">
            <span>Still loading.</span>
            <Button onClick={onRetry}>Try again</Button>
          </p>
        ) : null}
      </div>
    </StageFrameView>
  );
}

function noop() {}
