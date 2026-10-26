import { useCallback, useEffect, useRef, useState } from "react";
import {
  createDiagnosticsBundle,
  type DiagnosticsBundleResult,
  fetchDiagnosticsMeta,
  fetchDiagnosticsReportStatus,
  submitDiagnosticsReport,
} from "../api";
import { errorMessage } from "../utils/apiError";
import { HelpDialogView } from "./HelpDialogView";

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
  const submitting = useRef(false);
  const activeReportUrl = useRef<string | null>(null);
  const requestGeneration = useRef(0);
  const [reportStatus, setReportStatus] = useState<string | null>(null);
  const [reportAvailable, setReportAvailable] = useState(false);
  const [issueUrl, setIssueUrl] = useState<string | null>(null);
  const [supportUrl, setSupportUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      requestGeneration.current += 1;
      setBusy(false);
      setError(null);
      setBundle(null);
      setDescription("");
      setConsent(false);
      setSubmitted(null);
      submitting.current = false;
      activeReportUrl.current = null;
      setReportStatus(null);
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
    if (!open || !submitted || issueUrl || reportStatus === "failed") return;
    let cancelled = false;
    const check = () => {
      void fetchDiagnosticsReportStatus(submitted)
        .then((result) => {
          if (!cancelled && activeReportUrl.current === submitted) {
            setReportStatus(result.status);
            if (result.status === "published") setIssueUrl(result.issue_url);
          }
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
  }, [open, submitted, issueUrl, reportStatus]);

  const onCreate = useCallback(async () => {
    requestGeneration.current += 1;
    const generation = requestGeneration.current;
    submitting.current = false;
    activeReportUrl.current = null;
    setSubmitted(null);
    setReportStatus(null);
    setIssueUrl(null);
    setBundle(null);
    setBusy(true);
    setError(null);
    try {
      const result = await createDiagnosticsBundle();
      if (!open || generation !== requestGeneration.current) {
        return;
      }
      setBundle(result);
      setSupportUrl(result.support_url);
    } catch (err) {
      if (!open || generation !== requestGeneration.current) {
        return;
      }
      setError(errorMessage(err));
    } finally {
      if (open && generation === requestGeneration.current) {
        setBusy(false);
      }
    }
  }, [open]);

  const onSubmit = useCallback(async () => {
    if (!bundle || !consent || submitted || submitting.current) return;
    const generation = requestGeneration.current;
    submitting.current = true;
    setBusy(true);
    setError(null);
    setReportStatus(null);
    setIssueUrl(null);
    try {
      const result = await submitDiagnosticsReport({
        filename: bundle.filename,
        description,
        consent,
      });
      if (!open || generation !== requestGeneration.current) return;
      activeReportUrl.current = result.status_url;
      setSubmitted(result.status_url);
      setReportStatus("queued");
    } catch (err) {
      if (open && generation === requestGeneration.current)
        setError(errorMessage(err));
    } finally {
      if (open && generation === requestGeneration.current) {
        submitting.current = false;
        setBusy(false);
      }
    }
  }, [bundle, consent, description, open, submitted]);

  const issueHref = bundle?.support_url ?? supportUrl;
  const fallbackHref =
    issueHref?.includes("github.com/") && issueHref.endsWith("/issues")
      ? `${issueHref}/new?template=bug_report.yml&what-happened=${encodeURIComponent(description)}&version=${encodeURIComponent(bundle?.app_version ?? "")}`
      : issueHref;

  return (
    <HelpDialogView
      open={open}
      onClose={onClose}
      busy={busy}
      error={error}
      bundle={bundle}
      description={description}
      onDescriptionChange={setDescription}
      consent={consent}
      onConsentChange={setConsent}
      submitted={submitted}
      reportStatus={reportStatus}
      issueUrl={issueUrl}
      reportAvailable={reportAvailable}
      issueHref={issueHref}
      fallbackHref={fallbackHref}
      onCreate={() => void onCreate()}
      onSubmit={() => void onSubmit()}
    />
  );
}
