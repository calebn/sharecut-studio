import { useAfter } from "../hooks/useAfter";
import { useViewportClass } from "../hooks/useViewportClass";
import { Button } from "../ui";

type Phase = "blank" | "blocks" | "slow";

export const SKELETON_RETRY_MS = 4000;

export function SkeletonBlock({
  circle = false,
  className,
}: {
  circle?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`sys-skeleton-block${circle ? " sys-skeleton-block--circle" : ""}${className ? ` ${className}` : ""}`}
      aria-hidden="true"
    />
  );
}

export type SkeletonProps = {
  /** Nothing is drawn before this. Default 300 ms. */
  blankMs?: number;
  /** "Still loading…" and Retry appear at this time. Default 4000 ms. */
  retryMs?: number;
  /** Fixes the elapsed time (stories, tests). Without it the timers run. */
  elapsedMs?: number;
  /** Real layout of the destination. */
  layout?: "list" | "cards" | "guest";
  rows?: number;
  onRetry?: () => void;
};

/** The guest frame: header, Player card, the Queue column and the center column. */
const GUEST_BLOCKS = [
  "header",
  "player",
  "queue",
  "queue",
  "queue",
  "queue",
  "center",
  "center",
  "center",
] as const;

const phaseOf = (elapsed: number, blankMs: number, retryMs: number): Phase =>
  elapsed >= retryMs ? "slow" : elapsed >= blankMs ? "blocks" : "blank";

/**
 * Nothing for 300 ms, then static grey blocks in the destination's layout, then
 * at 4 s "Still loading…" with Retry. No shimmer until the animation pass.
 */
export function Skeleton({
  blankMs = 300,
  retryMs = SKELETON_RETRY_MS,
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
  const shell = useViewportClass();
  return (
    <div
      className={`sys-skeleton${layout === "guest" ? " sys-skeleton--guest" : ""}`}
      aria-busy="true"
      data-phase={phase}
    >
      {phase === "blank" ? null : (
        <div
          className={`sys-skeleton-blocks sys-skeleton-blocks--${layout}`}
          data-shell={layout === "guest" ? shell : undefined}
          aria-hidden="true"
        >
          {layout === "guest"
            ? GUEST_BLOCKS.map((part, at) => (
                <span
                  // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
                  key={at}
                  className={`sys-skeleton-block sys-skeleton-block--${part}`}
                />
              ))
            : Array.from({ length: rows }, (_, row) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
                <SkeletonBlock key={row} />
              ))}
        </div>
      )}
      {phase === "slow" ? (
        <p className="sys-skeleton-slow" role="status">
          <span>Still loading…</span>
          <Button className="sys-skeleton-retry" onClick={onRetry}>
            Retry
          </Button>
        </p>
      ) : null}
    </div>
  );
}
