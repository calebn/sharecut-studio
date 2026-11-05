import { useCallback, useEffect, useRef, useState } from "react";
import {
  createDiagnosticsBundle,
  fetchDiagnosticsMeta,
  submitDiagnosticsReport,
} from "../../api";
import { copyText } from "../../record";
import { errorMessage } from "../../utils/apiError";
import { clearOutbox, queueReport, useHelpOutbox } from "./helpOutbox";
import {
  type BundlePreview,
  type PreviewState,
  type ReportPhase,
  referenceOf,
  sendBlockedReason,
  supportLink,
} from "./helpReport";

export type HelpReport = {
  description: string;
  setDescription: (value: string) => void;
  preview: PreviewState;
  togglePreview: () => void;
  phase: ReportPhase;
  blockedReason: string | undefined;
  send: () => void;
  copyReference: () => Promise<boolean>;
  reset: () => void;
};

async function makeBundle(): Promise<BundlePreview> {
  const made = await createDiagnosticsBundle();
  return {
    filename: made.filename,
    path: made.path,
    files: made.files,
    sizeBytes: made.size_bytes,
    appVersion: made.app_version,
  };
}

/**
 * Report a problem over the diagnostics API: the bundle is made on this
 * computer, shown on request, and uploaded only when the person sends it.
 * Offline, the bundle stays here and the outbox sends it on reconnect.
 */
export function useHelpReport(open: boolean): HelpReport {
  const [description, setDescriptionState] = useState("");
  const [preview, setPreview] = useState<PreviewState>({ kind: "closed" });
  const [local, setLocal] = useState<ReportPhase>({ kind: "editing" });
  const bundle = useRef<BundlePreview | null>(null);
  const meta = useRef<{ available: boolean; support: string | null }>({
    available: false,
    support: null,
  });
  const generation = useRef(0);
  const outbox = useHelpOutbox();

  const reset = useCallback(() => {
    generation.current += 1;
    bundle.current = null;
    setDescriptionState("");
    setPreview({ kind: "closed" });
    setLocal({ kind: "editing" });
    clearOutbox();
  }, []);

  useEffect(() => {
    if (!open) return;
    let live = true;
    void fetchDiagnosticsMeta()
      .then((next) => {
        if (live)
          meta.current = {
            available: next.report_available,
            support: next.support_url,
          };
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [open]);

  const wasOpen = useRef(false);
  const inFlight = useRef(false);
  const busy =
    local.kind === "sending" ||
    outbox.kind === "waiting" ||
    outbox.kind === "sending";
  useEffect(() => {
    inFlight.current = busy;
  }, [busy]);
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    if (!inFlight.current) reset();
  }, [open, reset]);

  const setDescription = useCallback((value: string) => {
    setDescriptionState(value);
    setLocal((now) => (now.kind === "failed" ? { kind: "editing" } : now));
  }, []);

  const ensureBundle = useCallback(async (): Promise<BundlePreview> => {
    if (bundle.current) return bundle.current;
    const made = await makeBundle();
    bundle.current = made;
    return made;
  }, []);

  const togglePreview = useCallback(() => {
    if (preview.kind === "loading") return;
    if (preview.kind === "ready" || preview.kind === "failed") {
      setPreview({ kind: "closed" });
      return;
    }
    const mine = generation.current;
    setPreview({ kind: "loading" });
    ensureBundle().then(
      (made) => {
        if (mine === generation.current)
          setPreview({ kind: "ready", bundle: made });
      },
      (cause: unknown) => {
        if (mine === generation.current)
          setPreview({ kind: "failed", reason: errorMessage(cause) });
      },
    );
  }, [preview.kind, ensureBundle]);

  const send = useCallback(() => {
    if (sendBlockedReason(description) || local.kind === "sending") return;
    const mine = generation.current;
    const text = description.trim();
    setLocal({ kind: "sending" });
    const run = async (): Promise<ReportPhase> => {
      const made = await ensureBundle();
      if (!meta.current.available) {
        return {
          kind: "saved",
          path: made.path,
          supportHref: supportLink(meta.current.support, text, made.appVersion),
        };
      }
      if (!navigator.onLine) {
        queueReport(made.filename, text);
        return { kind: "queued" };
      }
      const result = await submitDiagnosticsReport({
        filename: made.filename,
        description: text,
        consent: true,
      });
      return { kind: "sent", reference: referenceOf(result.status_url) };
    };
    run().then(
      (next) => {
        if (mine === generation.current) setLocal(next);
      },
      (cause: unknown) => {
        if (mine === generation.current)
          setLocal({ kind: "failed", reason: errorMessage(cause) });
      },
    );
  }, [description, local.kind, ensureBundle]);

  const copyReference = useCallback(async () => {
    const reference =
      local.kind === "sent"
        ? local.reference
        : outbox.kind === "sent"
          ? outbox.reference
          : null;
    if (!reference) return false;
    try {
      await copyText(reference);
      return true;
    } catch {
      return false;
    }
  }, [local, outbox]);

  const phase = phaseOf(local, outbox);
  return {
    description,
    setDescription,
    preview,
    togglePreview,
    phase,
    blockedReason: sendBlockedReason(description),
    send,
    copyReference,
    reset,
  };
}

/** A report that went to the outbox shows what the outbox did with it. */
function phaseOf(
  local: ReportPhase,
  outbox: ReturnType<typeof useHelpOutbox>,
): ReportPhase {
  if (local.kind !== "queued") return local;
  if (outbox.kind === "sending") return { kind: "sending" };
  if (outbox.kind === "sent")
    return { kind: "sent", reference: outbox.reference };
  if (outbox.kind === "failed")
    return { kind: "failed", reason: "The report didn't send." };
  return local;
}
