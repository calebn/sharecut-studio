import { useEffect, useId, useRef, useState } from "react";
import {
  runBootstrap,
  type WhisperModelChoice,
  waitForBootstrapJob,
} from "../api";
import { Button, Dialog, InlineError } from "../ui";
import { errorMessage } from "../utils/apiError";

export type WhisperDownloadReason = "select" | "run";

export type WhisperDownloadRequest = {
  modelId: string;
  reason: WhisperDownloadReason;
  previousId?: string;
};

function optionLabel(model: WhisperModelChoice): string {
  const chrome = model.cached ? "Downloaded" : "Needs download";
  return `${model.label} (${model.id}, ${model.size}) — ${chrome}`;
}

type PickerProps = {
  fieldLabel: string;
  fieldDescription: string;
  value: string;
  defaultValue: string;
  models: WhisperModelChoice[];
  disabled?: boolean;
  highlighted?: boolean;
  onSelectCached: (modelId: string) => void;
  onSelectMissing: (modelId: string, previousId: string) => void;
};

export function WhisperModelPicker({
  fieldLabel,
  fieldDescription,
  value,
  defaultValue,
  models,
  disabled = false,
  highlighted = false,
  onSelectCached,
  onSelectMissing,
}: PickerProps) {
  const selectId = useId();
  const selected =
    models.find((m) => m.id === value) ??
    models.find((m) => m.id === defaultValue) ??
    null;

  const onSelectChange = (nextId: string) => {
    const row = models.find((m) => m.id === nextId);
    if (row?.cached) {
      onSelectCached(nextId);
      return;
    }
    onSelectMissing(nextId, value || defaultValue);
  };

  const catalog = models.length
    ? models
    : [
        {
          id: value || defaultValue || "large-v3-turbo",
          label: "Whisper model",
          size: "?",
          description: fieldDescription,
          cached: false,
        },
      ];

  return (
    <div
      className={`pipeline-param${
        highlighted ? " pipeline-param-highlight" : ""
      }`}
    >
      <label className="pipeline-whisper-label" htmlFor={selectId}>
        <span className="pipeline-param-label">{fieldLabel}</span>
        <select
          id={selectId}
          value={value || defaultValue}
          disabled={disabled}
          onChange={(e) => onSelectChange(e.target.value)}
        >
          {catalog.map((opt) => (
            <option key={opt.id} value={opt.id}>
              {optionLabel(opt)}
            </option>
          ))}
        </select>
      </label>
      <span className="pipeline-param-help">{fieldDescription}</span>
      <span className="pipeline-whisper-status" role="status">
        {selected
          ? selected.cached
            ? `${selected.label} is downloaded (${selected.size}).`
            : `${selected.label} needs download (${selected.size}).`
          : "Choose a Whisper speech model."}
      </span>
      <span className="pipeline-param-default">Default: {defaultValue}</span>
    </div>
  );
}

type DialogProps = {
  pending: WhisperDownloadRequest | null;
  models: WhisperModelChoice[];
  onDefer: (modelId: string) => void;
  onCancel: () => void;
  onDownloaded: (modelId: string) => void;
};

export function WhisperDownloadDialog({
  pending,
  models,
  onDefer,
  onCancel,
  onDownloaded,
}: DialogProps) {
  const downloadBtnRef = useRef<HTMLButtonElement>(null);
  const inFlightRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialogOpen = pending != null;
  const pendingModel =
    pending != null
      ? (models.find((m) => m.id === pending.modelId) ?? null)
      : null;

  useEffect(() => {
    if (!dialogOpen) {
      setBusy(false);
      setProgress(null);
      setError(null);
    }
  }, [dialogOpen]);

  const closeOrRevert = () => {
    if (busy) {
      return;
    }
    onCancel();
  };

  const startDownload = async () => {
    if (!pending || inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;
    setBusy(true);
    setError(null);
    setProgress("Starting download…");
    try {
      const started = await runBootstrap({
        components: ["whisper"],
        whisper_model: pending.modelId,
      });
      const job = started.job;
      setProgress(job.message ?? "Downloading…");
      await waitForBootstrapJob(job.id, {
        onUpdate: (next) => {
          if (next.message) {
            setProgress(next.message);
          }
        },
      });
      onDownloaded(pending.modelId);
    } catch (e: unknown) {
      setError(errorMessage(e));
      setBusy(false);
    } finally {
      inFlightRef.current = false;
    }
  };

  return (
    <Dialog
      open={dialogOpen}
      onClose={closeOrRevert}
      title="Download Whisper model?"
      panelClassName="pipeline-whisper-dialog"
      initialFocusRef={downloadBtnRef}
    >
      <p>
        {pendingModel
          ? `${pendingModel.label} (${pendingModel.id}) is about ${pendingModel.size}.`
          : `Model ${pending?.modelId ?? ""} is not on disk yet.`}{" "}
        Download it now before transcription, or keep the selection and download
        later. Run will not start until the weights are present.
      </p>
      {progress ? (
        <p
          className="pipeline-whisper-progress"
          role="status"
          aria-live="polite"
        >
          {progress}
        </p>
      ) : null}
      <InlineError message={error} />
      <div className="pipeline-whisper-actions">
        <Button
          ref={downloadBtnRef}
          variant="primary"
          type="button"
          disabled={busy}
          onClick={() => void startDownload()}
        >
          {busy ? "Downloading…" : "Download"}
        </Button>
        <Button
          type="button"
          disabled={busy || pending == null}
          onClick={() => {
            if (pending) {
              onDefer(pending.modelId);
            }
          }}
        >
          Use without downloading
        </Button>
        <Button type="button" disabled={busy} onClick={closeOrRevert}>
          Cancel
        </Button>
      </div>
    </Dialog>
  );
}
