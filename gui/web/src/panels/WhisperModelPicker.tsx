import { useEffect, useId, useRef } from "react";
import { type WhisperModelChoice } from "../api";
import { useBootstrapDownload } from "../hooks/useBootstrapDownload";
import { Button, Dialog, InlineError } from "../ui";

/** A pipeline run mode: an ordinary run, forced re-transcription, or a forced-aligner re-time. */
export type PipelineRunMode = "run" | "retranscribe" | "retime";

export type WhisperDownloadReason = "select" | PipelineRunMode;

export type WhisperDownloadRequest = {
  modelId: string;
  reason: WhisperDownloadReason;
  previousId?: string;
  /** Re-transcribe / Re-time words only: the user confirmed replacing hand-edited transcripts. */
  overwriteEdited?: boolean;
};

function optionLabel(model: WhisperModelChoice): string {
  const chrome = model.cached ? "Downloaded" : "Needs download";
  return `${model.label} (${model.id}, ${model.size}) · ${chrome}`;
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
  const { busy, progress, error, download, reset } = useBootstrapDownload();
  const dialogOpen = pending != null;
  const pendingModel =
    pending != null
      ? (models.find((m) => m.id === pending.modelId) ?? null)
      : null;

  useEffect(() => {
    if (!dialogOpen) {
      reset();
    }
  }, [dialogOpen, reset]);

  const closeOrRevert = () => {
    if (busy) {
      return;
    }
    onCancel();
  };

  const startDownload = async () => {
    if (!pending) {
      return;
    }
    if (
      await download({
        components: ["whisper"],
        whisper_model: pending.modelId,
      })
    ) {
      onDownloaded(pending.modelId);
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
