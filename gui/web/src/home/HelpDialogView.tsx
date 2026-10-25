import type { DiagnosticsBundleResult } from "../api";
import { Button, Dialog, InlineError } from "../ui";
import { BUSY_REASON } from "../ui/disabledReason";

export type HelpDialogViewProps = {
  open: boolean;
  onClose: () => void;
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
  onClose,
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
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Help"
      panelClassName="share-dialog-panel"
      footer={
        <div className="share-dialog-actions">
          <Button
            variant={bundle ? "default" : "primary"}
            type="button"
            disabledReason={busy ? BUSY_REASON : undefined}
            aria-busy={busy || undefined}
            onClick={onCreate}
          >
            {busy ? "Creating…" : "Create diagnostics bundle"}
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
      }
    >
      <div className="share-dialog-body stack">
        <p className="host-mcp-lead">
          Create a sanitized diagnostics zip on this computer. Nothing is
          uploaded when you create it. Preview it before deciding whether to
          send. The zip contains no audio, transcripts, or project JSON.
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
            <p>Files: {bundle.files.join(", ")}</p>
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
                I agree to upload my description and diagnostics ZIP. Both will
                be publicly accessible; the ZIP link expires after 30 days.
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
              If submission is unavailable, reveal the zip in your file manager
              (macOS Downloads: Option-Command-L) and attach it to the support
              request. The bundle is not sent anywhere until you attach it.
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
    </Dialog>
  );
}
