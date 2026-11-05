import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  createDiagnosticsBundle,
  type DiagnosticsBundleResult,
  fetchDiagnosticsMeta,
  fetchDiagnosticsReportStatus,
  submitDiagnosticsReport,
} from "../api";
import type { HelpStep } from "../state/types";
import { errorMessage } from "../utils/apiError";
import { useStableCallback } from "../utils/useStableCallback";
import { HelpDialogView } from "./HelpDialogView";

type Props = {
  open: boolean;
  anchorRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
  initialStep?: HelpStep;
  onOpenShortcuts?: () => void;
  onOpenGuides?: () => void;
};

export function HelpDialog({
  open,
  anchorRef,
  onClose,
  initialStep = "menu",
  onOpenShortcuts,
  onOpenGuides,
}: Props) {
  const [step, setStep] = useState<HelpStep>(initialStep);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setStep(initialStep);
  }
  const [session, setSession] = useState({ open, epoch: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bundle, setBundle] = useState<DiagnosticsBundleResult | null>(null);
  const [description, setDescription] = useState("");
  const [consent, setConsent] = useState(false);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const submitting = useRef(false);
  const [reportSent, setReportSent] = useState(false);
  const activeReportUrl = useRef<string | null>(null);
  const requestGeneration = useRef(0);
  const [reportStatus, setReportStatus] = useState<string | null>(null);
  const [reportAvailable, setReportAvailable] = useState(false);
  const [issueUrl, setIssueUrl] = useState<string | null>(null);
  const [supportUrl, setSupportUrl] = useState<string | null>(null);
  if (session.open !== open) {
    setSession({ open, epoch: session.epoch + 1 });
    if (!open) {
      setBusy(false);
      setError(null);
      setBundle(null);
      if (reportSent) setDescription("");
      setReportSent(false);
      setConsent(false);
      setSubmitted(null);
      setReportStatus(null);
      setIssueUrl(null);
    }
  }
  const acceptsSession = useStableCallback(
    (epoch: number) => open && session.epoch === epoch,
  );

  useEffect(() => {
    if (!open) {
      requestGeneration.current += 1;
      submitting.current = false;
      activeReportUrl.current = null;
      return;
    }
    let cancelled = false;
    void fetchDiagnosticsMeta()
      .then((meta) => {
        if (!cancelled && acceptsSession(session.epoch)) {
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
  }, [open, session.epoch, acceptsSession]);

  useEffect(() => {
    if (!open || !submitted || issueUrl || reportStatus === "failed") return;
    let cancelled = false;
    const check = () => {
      void fetchDiagnosticsReportStatus(submitted)
        .then((result) => {
          if (
            !cancelled &&
            acceptsSession(session.epoch) &&
            activeReportUrl.current === submitted
          ) {
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
  }, [open, submitted, issueUrl, reportStatus, session.epoch, acceptsSession]);

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
      if (
        !acceptsSession(session.epoch) ||
        generation !== requestGeneration.current
      ) {
        return;
      }
      setBundle(result);
      setSupportUrl(result.support_url);
    } catch (err) {
      if (
        !acceptsSession(session.epoch) ||
        generation !== requestGeneration.current
      ) {
        return;
      }
      setError(errorMessage(err));
    } finally {
      if (
        acceptsSession(session.epoch) &&
        generation === requestGeneration.current
      ) {
        setBusy(false);
      }
    }
  }, [session.epoch, acceptsSession]);

  const onSubmit = useCallback(async () => {
    if (!bundle || !consent || submitted || submitting.current) return;
    const generation = requestGeneration.current;
    const sentDescription = description;
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
      if (
        !acceptsSession(session.epoch) ||
        generation !== requestGeneration.current
      ) {
        // Clear only the draft that was sent, not one typed since a reopen.
        setDescription((current) =>
          current === sentDescription ? "" : current,
        );
        return;
      }
      activeReportUrl.current = result.status_url;
      setReportSent(true);
      setSubmitted(result.status_url);
      setReportStatus("queued");
    } catch (err) {
      if (
        acceptsSession(session.epoch) &&
        generation === requestGeneration.current
      )
        setError(errorMessage(err));
    } finally {
      if (
        acceptsSession(session.epoch) &&
        generation === requestGeneration.current
      ) {
        submitting.current = false;
        setBusy(false);
      }
    }
  }, [bundle, consent, description, submitted, session.epoch, acceptsSession]);

  const issueHref = bundle?.support_url ?? supportUrl;
  const fallbackHref =
    issueHref?.includes("github.com/") && issueHref.endsWith("/issues")
      ? `${issueHref}/new?template=bug_report.yml&what-happened=${encodeURIComponent(description)}&version=${encodeURIComponent(bundle?.app_version ?? "")}`
      : issueHref;

  return (
    <HelpDialogView
      open={open}
      anchorRef={anchorRef}
      onClose={onClose}
      step={step}
      onStepChange={setStep}
      onOpenShortcuts={onOpenShortcuts ?? (() => undefined)}
      onOpenGuides={onOpenGuides ?? (() => undefined)}
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
