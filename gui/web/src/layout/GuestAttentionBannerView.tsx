import type { OfflineConflict } from "../state/offlineStore";
import { plural } from "../utils/format";

/** Conflict list items shown before the rest are truncated. */
export const ATTENTION_LISTED_CONFLICTS = 5;

export interface GuestAttentionBannerViewProps {
  /** Count of host edits queued but not yet applied. */
  pending: number;
  conflicts: readonly OfflineConflict[];
  onDismissAll: () => void;
}

/** Props-only guest-attention rendering for live state and static catalog cases. */
export function GuestAttentionBannerView({
  pending,
  conflicts,
  onDismissAll,
}: GuestAttentionBannerViewProps) {
  if (conflicts.length === 0 && pending === 0) {
    return null;
  }

  return (
    <div className="guest-attention" role="alert">
      <div className="guest-attention-head">
        <strong>Needs attention</strong>
        <span>
          {pending > 0 ? `${pending} pending` : ""}
          {pending > 0 && conflicts.length > 0 ? ", " : ""}
          {conflicts.length > 0
            ? `${conflicts.length} ${plural(conflicts.length, "conflict")}`
            : ""}
        </span>
        {conflicts.length > 0 && (
          <button
            type="button"
            className="guest-attention-dismiss"
            onClick={onDismissAll}
          >
            Dismiss all
          </button>
        )}
      </div>
      <ul className="guest-attention-list">
        {conflicts.slice(0, ATTENTION_LISTED_CONFLICTS).map((c) => (
          <li key={c.command.command_id}>
            <code>{c.command.type}</code>: {c.reason}
          </li>
        ))}
      </ul>
    </div>
  );
}
