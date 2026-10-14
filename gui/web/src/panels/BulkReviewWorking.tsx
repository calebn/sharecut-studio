import { useNowSec } from "../hooks/useNowSec";
import { formatTimeShort } from "../utils/time";

type Props = {
  verb: "Approving" | "Rejecting";
  count: number;
  startedAtSec: number;
};

/** Seconds a bulk review stays quiet about elapsed time; a fast one never shows a clock. */
const ELAPSED_AFTER_SEC = 2;

/**
 * The in-place working state of a bulk review: what is running and, once it is not
 * instant, how long it has run. No percent, because the host reports none for this
 * command (docs/progress.md: never a fake bar).
 */
export function BulkReviewWorking({ verb, count, startedAtSec }: Props) {
  const nowSec = useNowSec(true);
  const elapsed = Math.max(0, nowSec - startedAtSec);
  return (
    <p className="impact-bulk-working" role="status" aria-live="polite">
      <span className="pipeline-pulse" aria-hidden="true" />
      <span>
        {verb} {count === 1 ? "1 edit" : `${count} edits`}…
        {elapsed >= ELAPSED_AFTER_SEC
          ? ` ${formatTimeShort(elapsed)} so far. Keep working, nothing is lost if you wait.`
          : ""}
      </span>
    </p>
  );
}
