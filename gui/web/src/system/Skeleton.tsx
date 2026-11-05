import { useAfter } from "../hooks/useAfter";
import { Button } from "../ui";

type Phase = "blank" | "blocks" | "slow";

export type SkeletonProps = {
  /** Nothing is drawn before this. Default 300 ms. */
  blankMs?: number;
  /** "Still loading…" and Retry appear at this time. Default 4000 ms. */
  retryMs?: number;
  /** Fixes the elapsed time (stories, tests). Without it the timers run. */
  elapsedMs?: number;
  /** Real layout of the destination. */
  layout?: "list" | "cards";
  rows?: number;
  onRetry?: () => void;
};

const phaseOf = (elapsed: number, blankMs: number, retryMs: number): Phase =>
  elapsed >= retryMs ? "slow" : elapsed >= blankMs ? "blocks" : "blank";

/**
 * Nothing for 300 ms, then static grey blocks in the destination's layout, then
 * at 4 s "Still loading…" with Retry. No shimmer until the animation pass.
 */
export function Skeleton({
  blankMs = 300,
  retryMs = 4000,
  elapsedMs,
  layout = "list",
  rows = 4,
  onRetry,
}: SkeletonProps) {
  const controlled = elapsedMs !== undefined;
  const blocks = useAfter(controlled ? null : blankMs);
  const slow = useAfter(controlled ? null : retryMs);
  const phase: Phase = controlled
    ? phaseOf(elapsedMs, blankMs, retryMs)
    : slow
      ? "slow"
      : blocks
        ? "blocks"
        : "blank";
  return (
    <div className="sys-skeleton" aria-busy="true" data-phase={phase}>
      {phase === "blank" ? null : (
        <div
          className={`sys-skeleton-blocks sys-skeleton-blocks--${layout}`}
          aria-hidden="true"
        >
          {Array.from({ length: rows }, (_, row) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
            <span key={row} className="sys-skeleton-block" />
          ))}
        </div>
      )}
      {phase === "slow" ? (
        <p className="sys-skeleton-slow" role="status">
          <span>Still loading…</span>
          <Button onClick={onRetry}>Retry</Button>
        </p>
      ) : null}
    </div>
  );
}
