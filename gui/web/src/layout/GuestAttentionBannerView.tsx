import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  canDismiss?: boolean;
  guest?: boolean;
  unreadable?: boolean;
  dismissFailed?: boolean;
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
  canDismiss = true,
  guest = false,
  onDismissAll,
  onSendNow,
  onRetry,
  onInspectHistory,
  unreadable = false,
  dismissFailed = false,
  checking = false,
}: GuestAttentionBannerViewProps) {
  const dismissReasonId = useId();
  const slotRef = useRef<HTMLDivElement>(null);
  const bannerRef = useRef<HTMLDivElement>(null);
  const [portalHost] = useState(() => document.createElement("div"));
  const visible = unreadable || conflicts.length > 0 || pending > 0;

  useLayoutEffect(() => {
    if (!visible) return;
    document.body.prepend(portalHost);
    let frame = 0;
    const place = () => {
      const slot = slotRef.current;
      const banner = bannerRef.current;
      if (slot && banner) {
        const rect = slot.getBoundingClientRect();
        for (const [property, value] of [
          ["left", `${rect.left}px`],
          ["top", `${rect.top}px`],
          ["width", `${rect.width}px`],
          ["--attention-panel-top", `${rect.bottom}px`],
        ]) {
          if (banner.style.getPropertyValue(property) !== value) {
            banner.style.setProperty(property, value);
          }
        }
      }
      frame = requestAnimationFrame(place);
    };
    place();
    return () => {
      cancelAnimationFrame(frame);
      portalHost.remove();
    };
  }, [visible, portalHost]);
  const dismissUnavailable = unreadable || checking || dismissFailed;
  const dismissReason = unreadable
    ? "Saved edits could not be read. Dismissal is unavailable."
    : dismissFailed
      ? "Dismissal failed. Your saved outcomes were kept."
      : "Checking saved edits. Dismissal is unavailable.";

  if (!visible) {
    return null;
  }

  const hiddenConflicts = Math.max(
    0,
    conflicts.length - ATTENTION_LISTED_CONFLICTS,
  );
  const attentionCount = pending + conflicts.length;
  const countLabel = [
    pending > 0 ? `${pending} pending` : "",
    conflicts.length > 0
      ? `${conflicts.length} ${plural(conflicts.length, "conflict")}`
      : "",
  ]
    .filter(Boolean)
    .join(", ");
  const alertLabel = [
    "Needs attention",
    countLabel,
    unreadable ? "Saved edits could not be read" : "",
    dismissFailed ? "Dismissal failed" : "",
  ]
    .filter(Boolean)
    .join(". ");

  return (
    <>
      <div ref={slotRef} className="guest-attention-slot" aria-hidden="true" />
      {createPortal(
        <div
          ref={bannerRef}
          id={ATTENTION_BANNER_ID}
          className="guest-attention"
          role="alert"
          tabIndex={-1}
          aria-label={alertLabel}
        >
          <div className="guest-attention-head">
            <strong>Attention</strong>
            <span role="img" aria-label={countLabel || alertLabel}>
              {attentionCount || "!"}
            </span>
            <details className="guest-attention-details">
              <summary aria-label="View attention details and recovery actions">
                Details
              </summary>
              <div className="guest-attention-details-content">
                {(pending > 0 && onSendNow) ||
                ((unreadable || dismissFailed) && onRetry) ? (
                  <span className="guest-attention-actions">
                    {pending > 0 && onSendNow && (
                      <Button onClick={onSendNow}>Send now</Button>
                    )}
                    {(unreadable || dismissFailed) && onRetry && (
                      <Button onClick={onRetry}>Retry</Button>
                    )}
                  </span>
                ) : null}
                {conflicts.length > 0 && canDismiss && (
                  <button
                    type="button"
                    className="guest-attention-dismiss"
                    aria-disabled={dismissUnavailable || undefined}
                    aria-describedby={
                      dismissUnavailable ? dismissReasonId : undefined
                    }
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
                <ul className="guest-attention-list">
                  {unreadable && (
                    <li>
                      Could not read saved edits on this device. Your saved
                      edits have been kept.
                    </li>
                  )}
                  {dismissFailed && (
                    <li>
                      Dismissal failed. Your saved outcomes have been kept.
                    </li>
                  )}
                  {conflicts.slice(0, ATTENTION_LISTED_CONFLICTS).map((c) => (
                    <li key={c.command.command_id}>
                      <code>{c.command.type}</code>: {c.reason}{" "}
                      {c.kind === "refused" ? (
                        <span>Edit the change and submit it again.</span>
                      ) : c.recovery === "inspect-history" ? (
                        <span>
                          {guest
                            ? "Ask the project owner to inspect History before trying this action again."
                            : "Inspect History before trying this action again."}
                        </span>
                      ) : (
                        <span>
                          The app will retry this same command automatically.
                        </span>
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
                        <Button onClick={onInspectHistory}>
                          Inspect History
                        </Button>
                      </li>
                    )}
                  {hiddenConflicts > 0 && (
                    <li key="more" className="guest-attention-more">
                      {overflowLabel(hiddenConflicts)}
                    </li>
                  )}
                </ul>
              </div>
            </details>
          </div>
        </div>,
        portalHost,
      )}
    </>
  );
}
