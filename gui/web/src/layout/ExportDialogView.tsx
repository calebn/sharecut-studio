import { useId } from "react";
import type { PipelineJobSnapshot } from "../types/pipeline";
import { Button, Dialog, InlineError } from "../ui";
import { lateCancelCopy } from "../utils/pipeline";
import {
  type ExportSettings,
  exportFileName,
  exportResultCopy,
  loudnessTargetCopy,
} from "./exportSettings";
import { JobProgressView } from "./JobProgressView";

/** One stage of an export, from settings to outcome. */
export type ExportStage =
  | {
      kind: "configure";
      /** Null while the Pipeline config loads, or when it failed to load. */
      settings: ExportSettings | null;
      settingsError: string | null;
      selected: readonly string[];
      /** Why Export is disabled, shown beside it. */
      blocker: string | null;
    }
  | {
      kind: "running";
      /** Null until the start request returns the job. */
      job: PipelineJobSnapshot | null;
      /** The job has started and no cancel is pending. */
      /** Why Cancel is unavailable right now, or null when it can run. */
      cancelReason: string | null;
      cancelling: boolean;
      cancelError: string | null;
    }
  | { kind: "done"; paths: readonly string[]; measured: string | null }
  | { kind: "failed"; reason: string }
  /** `paths`: files the job wrote before the cancel reached it. */
  | { kind: "cancelled"; paths: readonly string[] };

export type ExportDialogViewProps = {
  open: boolean;
  onClose: () => void;
  stage: ExportStage;
  onToggleFormat: (key: string, on: boolean) => void;
  onExport: () => void;
  onCancelExport: () => void;
  /** Back to settings after a failure or cancel. */
  onRestart: () => void;
  /** Fixed wall-clock seconds for catalog previews; omit to tick live. */
  nowSec?: number;
};

/**
 * Export deliverables dialog paint: settings before start, progress with
 * Cancel during the job, and what was written afterwards. Job start/follow and
 * Pipeline config loading stay with the `ExportDialog` adapter.
 */
export function ExportDialogView(props: ExportDialogViewProps) {
  const { open, onClose, stage } = props;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Export deliverables"
      panelClassName="bounce-dialog-panel"
      footer={<ExportDialogFooter {...props} />}
    >
      <div className="bounce-dialog-body">
        {stage.kind === "configure" ? <ExportSettingsForm {...props} /> : null}
        {stage.kind === "running" ? (
          <ExportProgress stage={stage} nowSec={props.nowSec} />
        ) : null}
        {stage.kind === "done" ? <ExportOutcome stage={stage} /> : null}
        {stage.kind === "failed" ? (
          <InlineError message={`Export failed: ${stage.reason}`} />
        ) : null}
        {stage.kind === "cancelled" ? <ExportCancelled stage={stage} /> : null}
      </div>
    </Dialog>
  );
}

function ExportSettingsForm({ stage, onToggleFormat }: ExportDialogViewProps) {
  const wavNoteId = useId();
  if (stage.kind !== "configure") {
    return null;
  }
  const { settings, settingsError, selected } = stage;
  const loudness = settings ? loudnessTargetCopy(settings.target) : null;
  return (
    <>
      <p className="export-dialog-lead">
        Writes the mastered episode to the project's export/ folder. Includes
        current SRT captions and a Markdown transcript when available. Files
        with the same names from an earlier export are replaced only once every
        file is written.
      </p>
      {settingsError ? (
        <InlineError
          message={`Export settings did not load: ${settingsError}. Export uses this project's saved formats.`}
        />
      ) : null}
      {settings ? (
        <fieldset className="bounce-dialog-fieldset">
          <legend>Files</legend>
          {settings.wav ? (
            <>
              <label className="bounce-dialog-check">
                <input
                  type="checkbox"
                  checked
                  disabled
                  aria-describedby={wavNoteId}
                />
                <span>WAV · lossless master</span>
              </label>
              <p
                id={wavNoteId}
                className="export-dialog-note export-dialog-indent"
              >
                Always written. Turn it off in the Pipeline tab.
              </p>
            </>
          ) : null}
          {settings.choices.map((choice) => (
            <label key={choice.key} className="bounce-dialog-check">
              <input
                type="checkbox"
                checked={selected.includes(choice.key)}
                onChange={(e) => onToggleFormat(choice.key, e.target.checked)}
              />
              <span>{choice.label}</span>
            </label>
          ))}
        </fieldset>
      ) : !settingsError ? (
        <p className="export-dialog-status" role="status">
          Loading export settings…
        </p>
      ) : null}
      {loudness ? (
        <p className="export-dialog-note">
          {loudness} Change the target in the Pipeline tab.
        </p>
      ) : null}
    </>
  );
}

function ExportProgress({
  stage,
  nowSec,
}: {
  stage: Extract<ExportStage, { kind: "running" }>;
  nowSec?: number;
}) {
  const { job, cancelling, cancelError } = stage;
  return (
    <>
      <JobProgressView
        job={job}
        headline={
          cancelling
            ? "Cancelling… If the master is still being prepared, the export stops once it is ready."
            : undefined
        }
        barLabel="Export progress"
        startingCopy="Starting export…"
        nowSec={nowSec}
      />
      <p className="export-dialog-note">
        You can close this window. The export keeps going, and once it starts
        the status bar shows its progress.
      </p>
      {cancelError ? (
        <InlineError message={`Cancel failed: ${cancelError}`} />
      ) : null}
    </>
  );
}

function ExportOutcome({
  stage,
}: {
  stage: Extract<ExportStage, { kind: "done" }>;
}) {
  return (
    <>
      <p className="export-dialog-status" role="status">
        {exportResultCopy(stage.paths)}
      </p>
      <ExportedFiles paths={stage.paths} />
      {stage.measured ? (
        <p className="export-dialog-note">{stage.measured}</p>
      ) : null}
    </>
  );
}

function ExportCancelled({
  stage,
}: {
  stage: Extract<ExportStage, { kind: "cancelled" }>;
}) {
  if (!stage.paths.length) {
    return (
      <p className="export-dialog-status" role="status">
        Export cancelled. Files from an earlier export are unchanged.
      </p>
    );
  }
  return (
    <>
      <p className="export-dialog-status" role="status">
        {lateCancelCopy(exportResultCopy(stage.paths))}
      </p>
      <ExportedFiles paths={stage.paths} />
    </>
  );
}

function ExportedFiles({ paths }: { paths: readonly string[] }) {
  if (!paths.length) {
    return null;
  }
  return (
    <ul className="export-dialog-files">
      {paths.map((path) => (
        <li key={path} title={path}>
          {exportFileName(path)}
        </li>
      ))}
    </ul>
  );
}

function ExportDialogFooter({
  stage,
  onClose,
  onExport,
  onCancelExport,
  onRestart,
}: ExportDialogViewProps) {
  return (
    <div className="bounce-dialog-footer">
      {stage.kind === "configure" && stage.blocker ? (
        <p className="export-dialog-note">{stage.blocker}</p>
      ) : null}
      <div className="bounce-dialog-actions">
        {stage.kind === "configure" ? (
          <Button
            variant="primary"
            type="button"
            disabledReason={
              stage.blocker != null
                ? stage.blocker
                : stage.settings == null && stage.settingsError == null
                  ? "Wait for the export settings to load."
                  : undefined
            }
            onClick={onExport}
          >
            Export
          </Button>
        ) : null}
        {stage.kind === "running" ? (
          <Button
            type="button"
            disabledReason={stage.cancelReason ?? undefined}
            onClick={onCancelExport}
          >
            {stage.cancelling ? "Cancelling…" : "Cancel export"}
          </Button>
        ) : null}
        {stage.kind === "done" ? (
          <Button variant="primary" type="button" onClick={onClose}>
            Done
          </Button>
        ) : null}
        {stage.kind === "failed" ? (
          <Button variant="primary" type="button" onClick={onRestart}>
            Try again
          </Button>
        ) : null}
        {stage.kind === "cancelled" ? (
          <Button type="button" onClick={onRestart}>
            Export again
          </Button>
        ) : null}
      </div>
    </div>
  );
}
