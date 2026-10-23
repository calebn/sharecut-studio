import { useEffect, useId, useRef, useState } from "react";
import { type WhisperModelChoice } from "../api";
import { ModelProgress, modelActivity, useModel } from "../models";
import { Button, Dialog, InlineError } from "../ui";
import { BUSY_REASON } from "../ui/disabledReason";

/** A pipeline run mode: an ordinary run, forced re-transcription, or a forced-aligner re-time. */
export type PipelineRunMode = "run" | "retranscribe" | "retime";

/** A size picked in the Whisper list that is not on disk yet; a run asks through the model gate instead. */
export type WhisperDownloadRequest = {
  modelId: string;
  previousId?: string;
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
  const { row, busy: slotBusy, download } = useModel("whisper");
  const { working, downloading, failure, blockedReason } = modelActivity(
    row,
    slotBusy,
  );
  /** This dialog started a download; an older failure of the same model is not its news. */
  const [tried, setTried] = useState(false);
  const busy = working;
  const dialogOpen = pending != null;
  const pendingModel =
    pending != null
      ? (models.find((m) => m.id === pending.modelId) ?? null)
      : null;

  useEffect(() => {
    if (!dialogOpen) {
      setTried(false);
    }
  }, [dialogOpen]);

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
    setTried(true);
    if ((await download({ whisperModel: pending.modelId })).kind === "ok") {
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
      footer={
        <div className="pipeline-whisper-actions">
          <Button
            ref={downloadBtnRef}
            variant="primary"
            type="button"
            disabledReason={busy ? BUSY_REASON : blockedReason}
            onClick={() => void startDownload()}
          >
            {busy ? "Downloading…" : "Download"}
          </Button>
          <Button
            type="button"
            disabledReason={
              busy
                ? BUSY_REASON
                : pending == null
                  ? "Choose a model first."
                  : undefined
            }
            onClick={() => {
              if (pending) {
                onDefer(pending.modelId);
              }
            }}
          >
            Use without downloading
          </Button>
          <Button
            type="button"
            disabledReason={busy ? BUSY_REASON : undefined}
            onClick={closeOrRevert}
          >
            Cancel
          </Button>
        </div>
      }
    >
      <p>
        {pendingModel
          ? `${pendingModel.label} (${pendingModel.id}) is about ${pendingModel.size}.`
          : `Model ${pending?.modelId ?? ""} is not on disk yet.`}{" "}
        Download it now before transcription, or keep the selection and download
        later. Run will ask before it starts.
      </p>
      {downloading ? (
        <ModelProgress state={downloading} label="Whisper" />
      ) : null}
      <InlineError message={tried ? failure?.plain : null} />
    </Dialog>
  );
}
