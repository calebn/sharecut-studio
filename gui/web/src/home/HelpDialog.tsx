import { useCallback, useEffect, useState } from "react";
import {
  createDiagnosticsBundle,
  type DiagnosticsBundleResult,
  fetchDiagnosticsMeta,
} from "../api";
import { Button, Dialog, InlineError } from "../ui";

type Props = {
  open: boolean;
  onClose: () => void;
};

export function HelpDialog({ open, onClose }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bundle, setBundle] = useState<DiagnosticsBundleResult | null>(null);
  const [supportUrl, setSupportUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setBusy(false);
      setError(null);
      setBundle(null);
      return;
    }
    let cancelled = false;
    void fetchDiagnosticsMeta()
      .then((meta) => {
        if (!cancelled) {
          setSupportUrl(meta.support_url);
        }
      })
      .catch(() => {
        /* link appears after a successful bundle */
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

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
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (open) {
        setBusy(false);
      }
    }
  }, [open]);

  const issueHref = bundle?.support_url ?? supportUrl;

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
          uploaded. Attach the zip to your support request — not audio,
          transcripts, or project JSON.
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
              Reveal the zip in your file manager (macOS Downloads:
              Option-Command-L) and attach it to the support request. The bundle
              is not sent anywhere until you attach it.
            </p>
          </div>
        ) : null}
        {issueHref ? (
          <p>
            <a href={issueHref} target="_blank" rel="noreferrer">
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
