import {
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
} from "react";
import {
  type ModelGate,
  ModelGateBody,
  ModelGateFooter,
  ModelProgress,
  type ModelView,
  modelActivity,
} from "../../models";
import type { PipelineJobSnapshot } from "../../types/pipeline";
import { Button, Dialog, Field, InlineError } from "../../ui";
import { BUSY_REASON, useDisabledReasonNote } from "../../ui/disabledReason";
import {
  MAX_SPLIT_SPEAKERS,
  MIN_SPLIT_SPEAKERS,
  type SplitSpeakersResult,
  splitSpeakersListenNotes,
} from "../../utils/speakerSplit";
import { formatTimeShort } from "../../utils/time";
import { JobProgressView } from "./JobProgressView";

/** One stage of a split, from the speaker count to the result. */
export type SplitSpeakersStage =
  | {
      kind: "configure";
      /** The count as typed, so a half-typed number is not rewritten. */
      count: string;
      /** One entry per speaker; blank means "Speaker N". */
      names: readonly string[];
      /** One optional voice sample per speaker, as the timeline seconds it covers. */
      samples: ReadonlyArray<{ startSec: number; endSec: number } | null>;
      /** Why the current selection cannot be a voice sample, or null when it can. */
      sampleReason: string | null;
      blocker: string | null;
      countError: string | null;
      speakerReadiness:
        | "checking"
        | "available"
        | "unavailable"
        | "check_failed";
    }
  | {
      kind: "running";
      job: PipelineJobSnapshot | null;
      /** Why Cancel is unavailable right now, or null when it can run. */
      cancelReason: string | null;
      cancelling: boolean;
      cancelError: string | null;
    }
  | {
      kind: "done";
      result: SplitSpeakersResult;
      reviewSpans: Array<{
        start_s: number;
        end_s: number;
        clock: "Timeline" | "Recording";
        labels: string[];
        trackNames: string[];
        timelineSec: number | null;
      }>;
      /** Length of the recording each track plays, when known. */
      durationSec: number | null;
      /** Undo reverses this split only while it is the latest change. */
      canUndo: boolean;
      undoing: boolean;
      undoError: string | null;
    }
  | { kind: "needsModel"; gate: ModelGate }
  | { kind: "failed"; reason: string }
  | { kind: "cancelled" };

export type SplitSpeakersDialogViewProps = {
  open: boolean;
  onClose: () => void;
  trackLabel: string;
  stage: SplitSpeakersStage;
  onCountChange: (count: string) => void;
  onNameChange: (index: number, name: string) => void;
  /** Keep the current selection as this speaker's voice sample. */
  onMarkSample: (index: number) => void;
  onClearSample: (index: number) => void;
  onListenSample: (index: number) => void;
  onSplit: () => void;
  onCancelSplit: () => void;
  onUndo: () => void;
  onGoTo: (sec: number) => void;
  /** Back to the settings after a failure, a cancel or an undo. */
  onRestart: () => void;
  /** The speaker model offered when recognition is unavailable, and whether any download holds the slot. */
  speakerModel?: {
    row: ModelView | null;
    busy: boolean;
  };
  onDownloadSpeakerModel: () => void;
  /** Shown with the settings after the person declined a model download. */
  modelHint?: ReactNode;
  /** Fixed wall-clock seconds for catalog previews; omit to tick live. */
  nowSec?: number;
};

/**
 * Split speakers dialog paint: the speaker count and names before start,
 * progress with Cancel during the job, then the new tracks with what to listen
 * for and one Undo. Job start/follow and the undo itself stay with the
 * `SplitSpeakersDialog` adapter.
 */
export function SplitSpeakersDialogView(props: SplitSpeakersDialogViewProps) {
  const { open, onClose, stage } = props;
  const countRef = useRef<HTMLInputElement>(null);
  const downloadRef = useRef<HTMLButtonElement>(null);
  const needsModel = stage.kind === "needsModel";
  useEffect(() => {
    if (needsModel) {
      downloadRef.current?.focus();
    }
  }, [needsModel]);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Split speakers"
      closeDisabled={
        stage.kind === "needsModel" &&
        stage.gate.prompt?.phase === "downloading"
      }
      panelClassName="split-speakers-panel"
      initialFocusRef={stage.kind === "configure" ? countRef : undefined}
      footer={<SplitSpeakersFooter {...props} downloadRef={downloadRef} />}
    >
      <div className="split-speakers-body">
        {stage.kind === "configure" ? (
          <SplitSpeakersForm {...props} countRef={countRef} />
        ) : null}
        {stage.kind === "running" ? (
          <SplitSpeakersProgress stage={stage} nowSec={props.nowSec} />
        ) : null}
        {stage.kind === "done" ? (
          <SplitSpeakersOutcome
            stage={stage}
            trackLabel={props.trackLabel}
            onGoTo={props.onGoTo}
          />
        ) : null}
        {stage.kind === "needsModel" && stage.gate.prompt ? (
          <ModelGateBody prompt={stage.gate.prompt} />
        ) : null}
        {stage.kind === "failed" ? (
          <InlineError message={`Split failed: ${stage.reason}`} />
        ) : null}
        {stage.kind === "cancelled" ? (
          <p className="export-dialog-status" role="status">
            Split cancelled. {props.trackLabel} is unchanged.
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

function shownSpeakerCount(raw: string): number {
  const count = Number(raw);
  return Number.isInteger(count)
    ? Math.min(Math.max(count, MIN_SPLIT_SPEAKERS), MAX_SPLIT_SPEAKERS)
    : MIN_SPLIT_SPEAKERS;
}

function SplitSpeakersForm({
  stage,
  trackLabel,
  onCountChange,
  onNameChange,
  onMarkSample,
  onClearSample,
  onListenSample,
  speakerModel,
  onDownloadSpeakerModel,
  modelHint,
  countRef,
}: SplitSpeakersDialogViewProps & {
  countRef: RefObject<HTMLInputElement | null>;
}) {
  const namesHintId = useId();
  const speakerDownload = modelActivity(
    speakerModel?.row ?? null,
    speakerModel?.busy ?? false,
  );
  const configure = stage.kind === "configure" ? stage : null;
  const shown = configure ? shownSpeakerCount(configure.count) : 0;
  const sampleNote = useDisabledReasonNote(
    configure &&
      configure.countError == null &&
      Array.from({ length: shown }, (_, i) => configure.samples[i]).some(
        (sample) => sample == null,
      )
      ? configure.sampleReason
      : null,
  );
  const downloadNote = useDisabledReasonNote(
    configure?.speakerReadiness === "unavailable" && !speakerDownload.working
      ? speakerDownload.blockedReason
      : null,
  );
  if (stage.kind !== "configure") {
    return null;
  }
  return (
    <>
      {stage.speakerReadiness === "unavailable" ? (
        <p className="export-dialog-note" role="status">
          <span>Speaker recognition isn't available on this computer.</span>{" "}
          <span>
            Download the speaker model to turn it on (about 80 MB, Apache-2.0,
            from SpeechBrain). It stays on this computer.
          </span>{" "}
          <Button
            type="button"
            disabledReason={
              speakerDownload.working
                ? BUSY_REASON
                : speakerDownload.blockedReason
            }
            aria-busy={speakerDownload.working || undefined}
            {...downloadNote.describedBy}
            onClick={onDownloadSpeakerModel}
          >
            {speakerDownload.working
              ? "Downloading…"
              : "Download speaker model"}
          </Button>
          {speakerDownload.downloading ? (
            <ModelProgress
              state={speakerDownload.downloading}
              label="Speaker model"
            />
          ) : null}
          <InlineError message={speakerDownload.failure?.plain} />
        </p>
      ) : null}
      {downloadNote.note}
      {stage.speakerReadiness === "checking" ? (
        <p className="export-dialog-note" role="status">
          Checking speaker recognition on this computer…
        </p>
      ) : null}
      {stage.speakerReadiness === "check_failed" ? (
        <p className="export-dialog-note" role="status">
          Couldn't check speaker recognition. Close and reopen this dialog to
          try again.
        </p>
      ) : null}
      {modelHint}
      <p className="export-dialog-lead">
        Splits {trackLabel} into one track per speaker. You can undo it.
      </p>
      <Field
        label="Number of speakers"
        hint="Count everyone who talks. Each track plays the same recording and goes quiet while someone else talks. Too high a number splits one voice in two."
        error={stage.countError}
      >
        {(control) => (
          <input
            {...control}
            ref={countRef}
            className="split-speakers-count"
            type="number"
            inputMode="numeric"
            min={MIN_SPLIT_SPEAKERS}
            max={MAX_SPLIT_SPEAKERS}
            step={1}
            value={stage.count}
            onChange={(e) => onCountChange(e.target.value)}
          />
        )}
      </Field>
      {stage.countError ? null : (
        <fieldset
          className="split-speakers-names"
          aria-describedby={namesHintId}
        >
          <legend>Names (optional)</legend>
          <p id={namesHintId} className="ui-field-hint">
            Blank names become Speaker 1, 2, and so on, in the order they talk.
          </p>
          <p className="ui-field-hint">
            If tracks come out wrong, select a few seconds of one person talking
            on the timeline, then choose Use selection under that speaker.
          </p>
          {sampleNote.note}
          <div className="split-speakers-name-grid">
            {Array.from({ length: shown }, (_, i) => {
              const sample = stage.samples[i] ?? null;
              const label = stage.names[i]?.trim() || `Speaker ${i + 1}`;
              return (
                <div key={i} className="split-speakers-name-cell">
                  <Field label={`Speaker ${i + 1}`}>
                    {(control) => (
                      <input
                        {...control}
                        type="text"
                        autoComplete="off"
                        value={stage.names[i] ?? ""}
                        onChange={(e) => onNameChange(i, e.target.value)}
                      />
                    )}
                  </Field>
                  <div className="split-speakers-sample">
                    {sample ? (
                      <>
                        <span className="split-speakers-sample-range">
                          Voice sample {formatTimeShort(sample.startSec)} ·{" "}
                          {formatTimeShort(sample.endSec - sample.startSec)}
                        </span>
                        <Button
                          type="button"
                          aria-label={`Listen to ${label}'s voice sample`}
                          onClick={() => onListenSample(i)}
                        >
                          Listen
                        </Button>
                        <Button
                          type="button"
                          aria-label={`Clear ${label}'s voice sample`}
                          onClick={() => onClearSample(i)}
                        >
                          Clear
                        </Button>
                      </>
                    ) : (
                      <Button
                        type="button"
                        aria-label={`Use selection as ${label}'s voice`}
                        disabledReason={stage.sampleReason ?? undefined}
                        {...sampleNote.describedBy}
                        onClick={() => onMarkSample(i)}
                      >
                        Use selection
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </fieldset>
      )}
    </>
  );
}

function SplitSpeakersProgress({
  stage,
  nowSec,
}: {
  stage: Extract<SplitSpeakersStage, { kind: "running" }>;
  nowSec?: number;
}) {
  return (
    <>
      <JobProgressView
        job={stage.job}
        headline={stage.cancelling ? "Cancelling…" : "Finding who is talking…"}
        unit={null}
        barLabel="Split progress"
        startingCopy="Starting the split…"
        nowSec={nowSec}
      />
      <p className="export-dialog-note">
        You can close this window. The split keeps going in the status bar.
      </p>
      {stage.cancelError ? (
        <InlineError message={`Cancel failed: ${stage.cancelError}`} />
      ) : null}
    </>
  );
}

function SplitSpeakersOutcome({
  stage,
  trackLabel,
  onGoTo,
}: {
  stage: Extract<SplitSpeakersStage, { kind: "done" }>;
  trackLabel: string;
  onGoTo: (sec: number) => void;
}) {
  const { result, durationSec } = stage;
  const notes = splitSpeakersListenNotes(result);
  return (
    <>
      <p className="export-dialog-status" role="status">
        Split {trackLabel} into {result.lanes.length} tracks.
      </p>
      <ul className="split-speakers-lanes" aria-label="New tracks">
        {result.lanes.map((lane) => (
          <li key={lane.track_id}>
            <span className="split-speakers-lane-name">{lane.name}</span>
            {durationSec != null ? (
              <span className="split-speakers-lane-time">
                Plays{" "}
                {formatTimeShort(Math.max(0, durationSec - lane.muted_sec))} of{" "}
                {formatTimeShort(durationSec)}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {notes.length ? (
        <>
          <h3 className="split-speakers-subhead">Listen for</h3>
          <ul className="split-speakers-notes">
            {notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </>
      ) : null}
      {stage.reviewSpans.length ? (
        <section
          className="split-speakers-review"
          aria-labelledby="split-review-title"
        >
          <h3 id="split-review-title" className="split-speakers-subhead">
            Review these stretches
          </h3>
          <p className="export-dialog-note">
            Times are on the timeline. Stretches removed from it show recording
            time.
          </p>
          <ul className="split-speakers-review-list">
            {stage.reviewSpans.map((span, index) => (
              <li key={`${span.start_s}:${span.end_s}:${index}`}>
                <div className="split-speakers-review-detail">
                  <span className="split-speakers-review-labels">
                    {span.labels.join(" · ")}
                  </span>
                  <span>
                    {span.clock} {formatTimeShort(span.start_s)} ·{" "}
                    {formatTimeShort(span.end_s - span.start_s)}
                  </span>
                  <span>{span.trackNames.join(", ")}</span>
                </div>
                <Button
                  disabledReason={
                    span.timelineSec == null
                      ? "This stretch is not on the timeline."
                      : undefined
                  }
                  onClick={() => {
                    if (span.timelineSec != null) onGoTo(span.timelineSec);
                  }}
                >
                  Go to
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {stage.canUndo ? (
        <p className="export-dialog-note">
          Two tracks sound like the same person? Undo the split and run it again
          with a voice sample marked for each speaker.
        </p>
      ) : null}
      {stage.undoError ? (
        <InlineError message={`Undo failed: ${stage.undoError}`} />
      ) : null}
      {!stage.canUndo ? (
        <p className="export-dialog-note">
          Something else changed since the split. Use History to go back.
        </p>
      ) : null}
    </>
  );
}

function SplitSpeakersFooter({
  stage,
  onClose,
  onSplit,
  onCancelSplit,
  onUndo,
  onRestart,
  downloadRef,
}: SplitSpeakersDialogViewProps & {
  downloadRef: RefObject<HTMLButtonElement | null>;
}) {
  const footerReason =
    stage.kind === "configure"
      ? stage.countError == null && stage.speakerReadiness === "available"
        ? stage.blocker
        : null
      : stage.kind === "running"
        ? stage.cancelReason
        : null;
  const footerNote = useDisabledReasonNote(footerReason);
  return (
    <div className="split-speakers-footer">
      {footerNote.note}
      <div className="split-speakers-actions">
        {stage.kind === "configure" ? (
          <Button
            variant="primary"
            type="button"
            disabledReason={stage.blocker ?? undefined}
            {...footerNote.describedBy}
            onClick={onSplit}
          >
            Split speakers
          </Button>
        ) : null}
        {stage.kind === "running" ? (
          <Button
            type="button"
            disabledReason={stage.cancelReason ?? undefined}
            {...footerNote.describedBy}
            onClick={onCancelSplit}
          >
            {stage.cancelling ? "Cancelling…" : "Cancel split"}
          </Button>
        ) : null}
        {stage.kind === "done" ? (
          <>
            {stage.canUndo ? (
              <Button
                type="button"
                disabledReason={stage.undoing ? BUSY_REASON : undefined}
                onClick={onUndo}
              >
                {stage.undoing ? "Undoing…" : "Undo split"}
              </Button>
            ) : null}
            <Button variant="primary" type="button" onClick={onClose}>
              Done
            </Button>
          </>
        ) : null}
        {stage.kind === "needsModel" ? (
          <ModelGateFooter gate={stage.gate} primaryRef={downloadRef} />
        ) : null}
        {stage.kind === "failed" ? (
          <Button variant="primary" type="button" onClick={onRestart}>
            Try again
          </Button>
        ) : null}
        {stage.kind === "cancelled" ? (
          <Button type="button" onClick={onRestart}>
            Split again
          </Button>
        ) : null}
      </div>
    </div>
  );
}
