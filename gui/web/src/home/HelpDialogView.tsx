import { type RefObject, useEffect, useRef, useState } from "react";
import type { DiagnosticsBundleResult } from "../api";
import type { HelpStep } from "../state/types";
import type { SystemIconName } from "../system/icons";
import { SystemIcon } from "../system/SystemIcon";
import { Button, Dialog, InlineError } from "../ui";
import { BUSY_REASON } from "../ui/disabledReason";

export type { HelpStep };

export type HelpDialogViewProps = {
  open: boolean;
  /** Desktop: the app menu button Help sits under as a popover. Left out, a sheet. */
  anchorRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  step: HelpStep;
  onStepChange: (step: HelpStep) => void;
  onOpenShortcuts: () => void;
  onOpenGuides: () => void;
  busy: boolean;
  error: string | null;
  bundle: DiagnosticsBundleResult | null;
  description: string;
  onDescriptionChange: (value: string) => void;
  consent: boolean;
  onConsentChange: (value: boolean) => void;
  submitted: string | null;
  reportStatus: string | null;
  issueUrl: string | null;
  reportAvailable: boolean;
  issueHref: string | null;
  fallbackHref: string | null;
  onCreate: () => void;
  onSubmit: () => void;
};

export function HelpDialogView({
  open,
  anchorRef,
  onClose,
  step,
  onStepChange,
  onOpenShortcuts,
  onOpenGuides,
  busy,
  error,
  bundle,
  description,
  onDescriptionChange,
  consent,
  onConsentChange,
  submitted,
  reportStatus,
  issueUrl,
  reportAvailable,
  issueHref,
  fallbackHref,
  onCreate,
  onSubmit,
}: HelpDialogViewProps) {
  const reportRowRef = useRef<HTMLButtonElement>(null);
  const createRef = useRef<HTMLButtonElement>(null);
  const seen = useRef({ open, step });
  const [shown, setShown] = useState({ open, step, changed: false });
  if (shown.open !== open || shown.step !== step) {
    setShown({ open, step, changed: open && shown.open });
  }
  useEffect(() => {
    const prev = seen.current;
    seen.current = { open, step };
    if (!open || !prev.open || prev.step === step) return;
    (step === "report" ? createRef : reportRowRef).current?.focus();
  }, [open, step]);
  const title = step === "menu" ? "Help" : "Export diagnostics";

  const rows: {
    label: string;
    icon: SystemIconName;
    onSelect: () => void;
    ariaLabel?: string;
  }[] = [
    {
      label: "Shortcuts and gestures",
      icon: "keyboard",
      onSelect: onOpenShortcuts,
    },
    {
      label: "Report a problem",
      icon: "message-square",
      onSelect: () => onStepChange("report"),
    },
    {
      label: "Guides",
      icon: "book-open",
      onSelect: onOpenGuides,
      ariaLabel: "Guides, opens in a new tab",
    },
  ];

  const back =
    step === "menu" ? undefined : (
      <button
        type="button"
        className="sys-icon-btn"
        aria-label="Back"
        title="Back"
        onClick={() => onStepChange("menu")}
      >
        <SystemIcon name="chevron-left" size={16} />
      </button>
    );
  const footer =
    step === "menu" ? undefined : (
      <div className="share-dialog-actions">
        <Button
          ref={createRef}
          variant={bundle ? "default" : "primary"}
          type="button"
          disabledReason={busy ? BUSY_REASON : undefined}
          aria-busy={busy || undefined}
          onClick={onCreate}
        >
          {busy ? "Exporting…" : "Export"}
        </Button>
        {reportAvailable && bundle ? (
          <Button
            variant="primary"
            type="button"
            disabledReason={
              busy
                ? BUSY_REASON
                : submitted
                  ? "This report is already submitted."
                  : description.trim().length < 10
                    ? "Describe the problem in at least 10 characters to submit."
                    : !consent
                      ? "Agree to the upload to submit."
                      : undefined
            }
            onClick={onSubmit}
          >
            {busy ? "Submitting…" : "Submit report"}
          </Button>
        ) : null}
      </div>
    );
  const body = (
    <>
      {step === "menu" ? (
        <ul className="help-sheet-rows" aria-label="Help">
          {rows.map((row) => (
            <li key={row.label}>
              <button
                ref={
                  row.label === "Report a problem" ? reportRowRef : undefined
                }
                type="button"
                className="help-sheet-row"
                aria-label={row.ariaLabel}
                onClick={row.onSelect}
              >
                <span className="help-sheet-row-label">
                  <SystemIcon name={row.icon} />
                  {row.label}
                </span>
                <SystemIcon name="chevron-right" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="share-dialog-body stack">
          <p className="host-mcp-lead">
            Includes logs and settings. No audio, transcripts or project files.
            Nothing is uploaded when you create it.
          </p>
          {bundle ? (
            <div className="stack" role="status" aria-live="polite">
              <p>
                Saved to <code>{bundle.path}</code>
              </p>
              <p>
                Bundle size: {(bundle.size_bytes / 1024).toFixed(1)} KiB. App
                version: {bundle.app_version}.
              </p>
              <details>
                <summary>Preview what's included</summary>
                <ul>
                  {bundle.files.map((file) => (
                    <li key={file}>{file}</li>
                  ))}
                </ul>
              </details>
              <label htmlFor="report-description">Describe the problem</label>
              <p id="report-description-hint">
                Enter at least 10 characters to submit a report.
              </p>
              <textarea
                id="report-description"
                aria-describedby="report-description-hint"
                value={description}
                maxLength={4000}
                onChange={(event) => onDescriptionChange(event.target.value)}
              />
              {reportAvailable ? (
                <label>
                  <input
                    type="checkbox"
                    checked={consent}
                    onChange={(event) => onConsentChange(event.target.checked)}
                  />
                  I agree to upload my description and diagnostics ZIP. Both
                  will be publicly accessible; the ZIP link expires after 30
                  days.
                </label>
              ) : null}
              {submitted ? (
                <p>
                  {reportStatus === "failed"
                    ? "Report publication failed. Download the ZIP and contact support. "
                    : reportStatus === "publish_uncertain"
                      ? "Publication needs operator review; check status later. "
                      : reportStatus === "published"
                        ? "Report published. "
                        : "Report queued for publication. "}
                  <a href={submitted} target="_blank" rel="noreferrer">
                    Check publication status
                  </a>
                  .{" "}
                  {issueUrl ? (
                    <a href={issueUrl} target="_blank" rel="noreferrer">
                      Open published issue
                    </a>
                  ) : null}
                </p>
              ) : null}
              <p>
                If submission is unavailable, reveal the zip in your file
                manager (macOS Downloads: Option-Command-L) and attach it to the
                support request. The bundle is not sent anywhere until you
                attach it.
              </p>
            </div>
          ) : null}
          {issueHref ? (
            <p>
              <a
                href={fallbackHref ?? undefined}
                target="_blank"
                rel="noreferrer"
              >
                Open support
              </a>
            </p>
          ) : null}
          <div className="share-dialog-live">
            <InlineError message={error} />
          </div>
        </div>
      )}
      <p className="sr-only" role="status">
        {shown.changed ? title : ""}
      </p>
    </>
  );
  const frame = {
    open,
    onClose,
    title,
    panelClassName: "help-sheet-panel",
    headerStart: back,
    footer,
  };

  return anchorRef ? (
    <Dialog
      {...frame}
      anchor={{
        reason:
          "On desktop Help is a popover under the app menu button that opened it (DLG-HELP).",
        ref: anchorRef,
      }}
    >
      {body}
    </Dialog>
  ) : (
    <Dialog {...frame}>{body}</Dialog>
  );
}
