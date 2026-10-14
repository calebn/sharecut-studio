import { useId } from "react";
import type { OfflineConflict } from "../state/offlineStore";
import { Button } from "../ui/Button";
import { overflowLabel, plural } from "../utils/format";

/** Conflict list items shown before the rest collapse into a "+N more" item. */
export const ATTENTION_LISTED_CONFLICTS = 5;

/** The banner's id, so the save state's "See why" can move focus to it. */
export const ATTENTION_BANNER_ID = "needs-attention";

export interface GuestAttentionBannerViewProps {
  /** Count of host edits queued but not yet applied. */
  pending: number;
  conflicts: readonly OfflineConflict[];
  unreadable?: boolean;
  checking?: boolean;
  onDismissAll: () => void;
  /** Send the queued host edits now. Offered beside a pending count. */
  onSendNow?: () => void;
  /** Read the saved edits again. Offered when they could not be read. */
  onRetry?: () => void;
  /** Open the existing History surface for a command that may have applied. */
  onInspectHistory?: () => void;
}

/** Props-only guest-attention rendering for live state and static catalog cases. */
export function GuestAttentionBannerView({
  pending,
  conflicts,
  onDismissAll,
  onSendNow,
  onRetry,
  onInspectHistory,
  unreadable = false,
  checking = false,
}: GuestAttentionBannerViewProps) {
  const dismissReasonId = useId();
  const dismissUnavailable = unreadable || checking;
  const dismissReason = unreadable
    ? "Saved edits could not be read. Dismissal is unavailable."
    : "Checking saved edits. Dismissal is unavailable.";

  if (!unreadable && conflicts.length === 0 && pending === 0) {
    return null;
  }

  const hiddenConflicts = Math.max(
    0,
    conflicts.length - ATTENTION_LISTED_CONFLICTS,
  );

  return (
    <div
      id={ATTENTION_BANNER_ID}
      className="guest-attention"
      role="alert"
      tabIndex={-1}
    >
      <div className="guest-attention-head">
        <strong>Needs attention</strong>
        <span>
          {pending > 0 ? `${pending} pending` : ""}
          {pending > 0 && conflicts.length > 0 ? ", " : ""}
          {conflicts.length > 0
            ? `${conflicts.length} ${plural(conflicts.length, "conflict")}`
            : ""}
        </span>
        {(pending > 0 && onSendNow) || (unreadable && onRetry) ? (
          <span className="guest-attention-actions">
            {pending > 0 && onSendNow && (
              <Button onClick={onSendNow}>Send now</Button>
            )}
            {unreadable && onRetry && <Button onClick={onRetry}>Retry</Button>}
          </span>
        ) : null}
        {conflicts.length > 0 && (
          <button
            type="button"
            className="guest-attention-dismiss"
            aria-disabled={dismissUnavailable || undefined}
            aria-describedby={dismissUnavailable ? dismissReasonId : undefined}
            title={dismissUnavailable ? dismissReason : undefined}
            onClick={onDismissAll}
          >
            Dismiss all
          </button>
        )}
        {conflicts.length > 0 && dismissUnavailable && (
          <span id={dismissReasonId} className="sr-only">
            {dismissReason}
          </span>
        )}
      </div>
      <ul className="guest-attention-list">
        {unreadable && (
          <li>
            Could not read saved edits on this device. Your saved edits have
            been kept.
          </li>
        )}
        {conflicts.slice(0, ATTENTION_LISTED_CONFLICTS).map((c) => (
          <li key={c.command.command_id}>
            <code>{c.command.type}</code>: {c.reason}{" "}
            {c.kind === "refused" ? (
              <span>Edit the change and submit it again.</span>
            ) : c.recovery === "inspect-history" ? (
              <span>Inspect History before trying this action again.</span>
            ) : (
              <span>Send now retries this same command.</span>
            )}
          </li>
        ))}
        {onInspectHistory &&
          conflicts.some(
            (conflict) =>
              conflict.kind === "unknown" &&
              conflict.recovery === "inspect-history",
          ) && (
            <li>
              <Button onClick={onInspectHistory}>Inspect History</Button>
            </li>
          )}
        {hiddenConflicts > 0 && (
          <li key="more" className="guest-attention-more">
            {overflowLabel(hiddenConflicts)}
          </li>
        )}
      </ul>
    </div>
  );
}
