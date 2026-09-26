import { useCallback, useEffect, useState } from "react";
import {
  createDiagnosticsBundle,
  type DiagnosticsBundleResult,
  fetchDiagnosticsMeta,
  fetchDiagnosticsReportStatus,
  submitDiagnosticsReport,
} from "../api";
import { Button, Dialog, InlineError } from "../ui";
import { errorMessage } from "../utils/apiError";

type Props = {
  open: boolean;
  onClose: () => void;
};

export function HelpDialog({ open, onClose }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bundle, setBundle] = useState<DiagnosticsBundleResult | null>(null);
  const [description, setDescription] = useState("");
  const [consent, setConsent] = useState(false);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [reportAvailable, setReportAvailable] = useState(false);
  const [issueUrl, setIssueUrl] = useState<string | null>(null);
  const [supportUrl, setSupportUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setBusy(false);
      setError(null);
      setBundle(null);
      setDescription("");
      setConsent(false);
      setSubmitted(null);
      setIssueUrl(null);
      return;
    }
    let cancelled = false;
    void fetchDiagnosticsMeta()
      .then((meta) => {
        if (!cancelled) {
          setSupportUrl(meta.support_url);
          setReportAvailable(meta.report_available);
        }
      })
      .catch(() => {
        /* link appears after a successful bundle */
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open || !submitted || issueUrl) return;
    let cancelled = false;
    const check = () => {
      void fetchDiagnosticsReportStatus(submitted)
        .then((result) => {
          if (!cancelled && result.status === "published")
            setIssueUrl(result.issue_url);
        })
        .catch(() => {
          /* keep the status link available */
        });
    };
    check();
    const timer = window.setInterval(check, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [open, submitted, issueUrl]);

  const onCreate = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await createDiagnosticsBundle();
      if (!open) {
        return;
      }
      setBundle(result);
      setSupportUrl(result.support_url);
    } catch (err) {
      if (!open) {
        return;
      }
      setError(errorMessage(err));
    } finally {
      if (open) {
        setBusy(false);
      }
    }
  }, [open]);

  const onSubmit = useCallback(async () => {
    if (!bundle || !consent) return;
    setBusy(true);
    setError(null);
    try {
      const result = await submitDiagnosticsReport({
        filename: bundle.filename,
        description,
        consent,
      });
      setSubmitted(result.status_url);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [bundle, consent, description]);

  const issueHref = bundle?.support_url ?? supportUrl;
  const fallbackHref =
    issueHref?.includes("github.com/") && issueHref.endsWith("/issues")
      ? `${issueHref}/new?template=bug_report.yml&what-happened=${encodeURIComponent(description)}&version=${encodeURIComponent(bundle?.app_version ?? "")}`
      : issueHref;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Help"
      panelClassName="share-dialog-panel"
    >
      <div className="share-dialog-body stack">
        <p className="host-mcp-lead">
          Create a sanitized diagnostics zip on this computer. Nothing is
          uploaded when you create it. Preview it before deciding whether to
          send. The zip contains no audio, transcripts, or project JSON.
        </p>
        <div className="share-dialog-actions">
          <Button
            variant="primary"
            type="button"
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={() => void onCreate()}
          >
            {busy ? "Creating…" : "Create diagnostics bundle"}
          </Button>
        </div>
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
            <textarea
              id="report-description"
              value={description}
              maxLength={4000}
              onChange={(event) => setDescription(event.target.value)}
            />
            {reportAvailable ? (
              <label>
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(event) => setConsent(event.target.checked)}
                />
                I agree to upload my description and diagnostics ZIP. Both will
                be publicly accessible; the ZIP link expires after 30 days.
              </label>
            ) : null}
            {reportAvailable ? (
              <Button
                type="button"
                disabled={busy || !consent || description.trim().length < 10}
                onClick={() => void onSubmit()}
              >
                {busy ? "Submitting…" : "Submit report"}
              </Button>
            ) : null}
            {submitted ? (
              <p>
                Report queued for publication.{" "}
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
        <div className="share-dialog-live" aria-live="polite">
          {error ? <InlineError message={error} /> : null}
        </div>
      </div>
    </Dialog>
  );
}
