import { useNowSec } from "../hooks/useNowSec";
import { formatTimeShort } from "../utils/time";

type Props = {
  verb: "Approving" | "Rejecting" | "Applying";
  count: number;
  startedAtSec: number;
};

/** Seconds a bulk review stays quiet about elapsed time; a fast one never shows a clock. */
const ELAPSED_AFTER_SEC = 2;

/**
 * The in-place working state of a bulk review: what is running and, once it is not
 * instant, how long it has run. No percent, because the host reports none for this
 * command (docs/progress.md: never a fake bar). The ticking clock stays outside the
 * live region so a screen reader hears the headline once, not every second.
 */
export function BulkReviewWorking({ verb, count, startedAtSec }: Props) {
  const noun = verb === "Applying" ? "suggested action" : "edit";
  const nowSec = useNowSec(true);
  const elapsed = Math.max(0, nowSec - startedAtSec);
  return (
    <div className="impact-bulk-working">
      <span className="pipeline-pulse" aria-hidden="true" />
      <span role="status" aria-live="polite">
        {verb} {count} {noun}
        {count === 1 ? "" : "s"}…
      </span>
      {elapsed >= ELAPSED_AFTER_SEC ? (
        <span>{formatTimeShort(elapsed)} so far.</span>
      ) : null}
    </div>
  );
}
