import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { OfflineConflict } from "../../services/offlineQueue/offlineStore";
import { Button } from "../../ui/Button";
import { overflowLabel } from "../../utils/format";
import {
  attentionCountLabel,
  attentionRegionLabel,
  conflictAdvice,
  DISMISS_FAILED_NOTE,
  dismissReason,
  NEEDS_ATTENTION,
  UNREADABLE_NOTE,
} from "./attentionLabel";

/** Conflict list items shown before the rest collapse into a "+N more" item. */
const ATTENTION_LISTED_CONFLICTS = 5;

/** The banner's id, so the save state's "See why" can move focus to it. */
export const ATTENTION_BANNER_ID = "needs-attention";

export interface GuestAttentionBannerViewProps {
  host?: HTMLElement | null;
  conflicts: readonly OfflineConflict[];
  canDismiss?: boolean;
  unreadable?: boolean;
  dismissFailed?: boolean;
  checking?: boolean;
  onDismissAll: () => void;
  /** Read the saved edits again. Offered when they could not be read. */
  onRetry?: () => void;
}

/** Props-only guest-attention rendering for live state and static catalog cases. */
export function GuestAttentionBannerView({
  host = null,
  conflicts,
  canDismiss = true,
  onDismissAll,
  onRetry,
  unreadable = false,
  dismissFailed = false,
  checking = false,
}: GuestAttentionBannerViewProps) {
  const dismissReasonId = useId();
  const slotRef = useRef<HTMLDivElement>(null);
  const bannerRef = useRef<HTMLDivElement>(null);
  const [portalHost] = useState(() => document.createElement("div"));
  const visible = unreadable || conflicts.length > 0;

  const focusedRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!visible) return;
    const destination = host?.isConnected ? host : slotRef.current;
    if (!destination) return;
    const active = document.activeElement;
    const focused = focusedRef.current;
    const restore =
      focused &&
      portalHost.contains(focused) &&
      (active === document.body || active === focused);
    destination.prepend(portalHost);
    if (restore) focused.focus({ preventScroll: true });
  }, [visible, host, portalHost]);
  useLayoutEffect(() => () => portalHost.remove(), [portalHost]);
  useLayoutEffect(() => {
    if (!visible) {
      focusedRef.current = null;
      portalHost.remove();
      return;
    }
    if (host) return;
    let frame = 0;
    const place = () => {
      const banner = bannerRef.current;
      const summary = banner?.querySelector("summary");
      if (banner && summary) {
        const value = `${summary.getBoundingClientRect().bottom}px`;
        if (banner.style.getPropertyValue("--attention-panel-top") !== value)
          banner.style.setProperty("--attention-panel-top", value);
      }
      frame = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(frame);
  }, [visible, host, portalHost]);
  const dismissUnavailable = unreadable || checking || dismissFailed;
  const dismissalReason = dismissReason({ unreadable, dismissFailed });

  if (!visible) {
    return null;
  }

  const hiddenConflicts = Math.max(
    0,
    conflicts.length - ATTENTION_LISTED_CONFLICTS,
  );
  const attentionCount = conflicts.length;
  const countLabel = attentionCountLabel(0, conflicts.length);
  const regionLabel = attentionRegionLabel({
    pending: 0,
    conflictCount: conflicts.length,
    unreadable,
    dismissFailed,
  });

  return (
    <>
      <div ref={slotRef} className="guest-attention-slot" />
      {createPortal(
        <div
          ref={bannerRef}
          id={ATTENTION_BANNER_ID}
          className={
            host
              ? "guest-attention guest-attention--inspector-flow"
              : "guest-attention"
          }
          onFocusCapture={(event) => {
            focusedRef.current = event.target;
          }}
          onBlurCapture={(event) => {
            if (
              event.relatedTarget instanceof Node &&
              !portalHost.contains(event.relatedTarget)
            )
              focusedRef.current = null;
          }}
          role="region"
          tabIndex={-1}
          aria-label={regionLabel}
        >
          <details className="guest-attention-details">
            <summary
              className="guest-attention-head"
              aria-label={`${NEEDS_ATTENTION} ${attentionCount || "!"} Details`}
            >
              <strong>{NEEDS_ATTENTION}</strong>{" "}
              <span role="img" aria-label={countLabel || regionLabel}>
                {attentionCount || "!"}
              </span>{" "}
              <span>Details</span>
            </summary>
            <div className="guest-attention-details-content">
              {(unreadable || dismissFailed) && onRetry ? (
                <span className="guest-attention-actions">
                  <Button onClick={onRetry}>Retry</Button>
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
                  title={dismissUnavailable ? dismissalReason : undefined}
                  onClick={onDismissAll}
                >
                  Dismiss all
                </button>
              )}
              {conflicts.length > 0 && dismissUnavailable && (
                <span id={dismissReasonId} className="sr-only">
                  {dismissalReason}
                </span>
              )}
              <ul className="guest-attention-list">
                {unreadable && <li>{UNREADABLE_NOTE}</li>}
                {dismissFailed && <li>{DISMISS_FAILED_NOTE}</li>}
                {conflicts.slice(0, ATTENTION_LISTED_CONFLICTS).map((c) => (
                  <li key={c.command.command_id}>
                    <code>{c.command.type}</code>: {c.reason}{" "}
                    <span>{conflictAdvice(c, true)}</span>
                  </li>
                ))}
                {hiddenConflicts > 0 && (
                  <li key="more" className="guest-attention-more">
                    {overflowLabel(hiddenConflicts)}
                  </li>
                )}
              </ul>
            </div>
          </details>
        </div>,
        portalHost,
      )}
    </>
  );
}
