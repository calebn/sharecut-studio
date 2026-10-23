import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { TranscriptRefineRecovery } from "../inspector/TranscriptRefineRecovery";
import type { OfflineConflict } from "../services/offlineQueue/offlineStore";
import { DocumentCommand } from "../types/documentCommands.generated";
import { Button } from "../ui/Button";
import {
  TRANSCRIPT_REFINE_REFUSAL,
  TRANSCRIPT_REFINE_REQUIRED_CODE,
} from "../utils/apiError";
import { overflowLabel } from "../utils/format";
import {
  ATTENTION_DETAILS_LABEL,
  attentionCountLabel,
  attentionRegionLabel,
  NEEDS_ATTENTION,
} from "./attentionLabel";

/** Conflict list items shown before the rest collapse into a "+N more" item. */
export const ATTENTION_LISTED_CONFLICTS = 5;

/** The banner's id, so the save state's "See why" can move focus to it. */
export const ATTENTION_BANNER_ID = "needs-attention";

export interface GuestAttentionBannerViewProps {
  /** Count of host edits queued but not yet applied. */
  pending: number;
  host?: HTMLElement | null;
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
  /** The host's project, set so a refine-gate refusal can be waived from here. */
  refineWaiverProject?: string;
}

const REFINE_WAIVED_MESSAGE =
  "Waiver recorded. Retry approval to apply pending edits.";

function RefineGateWaiver({
  projectPath,
  reason,
  waived,
  onWaived,
}: {
  projectPath: string;
  reason: string;
  waived: boolean;
  onWaived: () => void;
}) {
  const statusRef = useRef<HTMLParagraphElement>(null);
  const wasWaived = useRef(waived);
  useLayoutEffect(() => {
    if (waived && !wasWaived.current) statusRef.current?.focus();
    wasWaived.current = waived;
  }, [waived]);
  if (waived)
    return (
      <p ref={statusRef} role="status" tabIndex={-1}>
        {REFINE_WAIVED_MESSAGE}
      </p>
    );
  return (
    <TranscriptRefineRecovery
      projectPath={projectPath}
      error={reason}
      errorCode={TRANSCRIPT_REFINE_REQUIRED_CODE}
      onRecovered={onWaived}
    />
  );
}

/** Props-only guest-attention rendering for live state and static catalog cases. */
export function GuestAttentionBannerView({
  pending,
  host = null,
  conflicts,
  canDismiss = true,
  guest = false,
  onDismissAll,
  onSendNow,
  onRetry,
  onInspectHistory,
  refineWaiverProject,
  unreadable = false,
  dismissFailed = false,
  checking = false,
}: GuestAttentionBannerViewProps) {
  const dismissReasonId = useId();
  const slotRef = useRef<HTMLDivElement>(null);
  const bannerRef = useRef<HTMLDivElement>(null);
  const [portalHost] = useState(() => document.createElement("div"));
  const visible = unreadable || conflicts.length > 0 || pending > 0;
  const [refineWaivedIds, setRefineWaivedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

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
  const listedIds = new Set(conflicts.map((c) => c.command.command_id));
  const keptWaivedIds = [...refineWaivedIds].filter((id) => listedIds.has(id));
  if (keptWaivedIds.length !== refineWaivedIds.size)
    setRefineWaivedIds(new Set(keptWaivedIds));
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
  const countLabel = attentionCountLabel(pending, conflicts.length);
  const regionLabel = attentionRegionLabel({
    pending,
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
          <details
            className="guest-attention-details"
            onToggle={(event) => {
              if (!event.currentTarget.open) return;
              event.currentTarget
                .querySelector(".transcript-refine-recovery")
                ?.scrollIntoView?.({ block: "nearest" });
            }}
          >
            <summary
              className="guest-attention-head"
              aria-label={ATTENTION_DETAILS_LABEL}
            >
              <strong>{NEEDS_ATTENTION}</strong>
              <span role="img" aria-label={countLabel || regionLabel}>
                {attentionCount || "!"}
              </span>
              <span>Details</span>
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
                    Could not read saved edits on this device. Your saved edits
                    have been kept.
                  </li>
                )}
                {dismissFailed && (
                  <li>Dismissal failed. Your saved outcomes have been kept.</li>
                )}
                {conflicts.slice(0, ATTENTION_LISTED_CONFLICTS).map((c) => {
                  const waivable =
                    c.kind === "refused" &&
                    refineWaiverProject !== undefined &&
                    c.reason === TRANSCRIPT_REFINE_REFUSAL;
                  return (
                    <li key={c.command.command_id}>
                      {waivable &&
                      c.command.type === DocumentCommand.ApproveEdits ? (
                        "Approve"
                      ) : (
                        <code>{c.command.type}</code>
                      )}
                      : {c.reason}{" "}
                      {waivable ? (
                        <RefineGateWaiver
                          projectPath={refineWaiverProject}
                          reason={c.reason}
                          waived={refineWaivedIds.has(c.command.command_id)}
                          onWaived={() =>
                            setRefineWaivedIds(
                              new Set(
                                conflicts
                                  .filter(
                                    (other) =>
                                      other.reason ===
                                      TRANSCRIPT_REFINE_REFUSAL,
                                  )
                                  .map((other) => other.command.command_id),
                              ),
                            )
                          }
                        />
                      ) : c.kind === "refused" ? (
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
                  );
                })}
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
        </div>,
        portalHost,
      )}
    </>
  );
}
