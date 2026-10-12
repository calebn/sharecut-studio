import { type RefObject, useId, useRef } from "react";
import type { PipelineJobSnapshot } from "../types/pipeline";
import { Button, Dialog, Field, InlineError } from "../ui";
import {
  MAX_SPLIT_SPEAKERS,
  MIN_SPLIT_SPEAKERS,
  type SplitSpeakersResult,
  splitSpeakersListenNotes,
} from "../utils/speakerSplit";
import { formatTimeShort } from "../utils/time";
import { JobProgressView } from "./JobProgressView";

/** One stage of a split, from the speaker count to the result. */
export type SplitSpeakersStage =
  | {
      kind: "configure";
      /** The count as typed, so a half-typed number is not rewritten. */
      count: string;
      /** One entry per speaker; blank means "Speaker N". */
      names: readonly string[];
      /** Why Split speakers is disabled, shown beside it. */
      blocker: string | null;
    }
  | {
      kind: "running";
      /** Null until the start request returns the job. */
      job: PipelineJobSnapshot | null;
      canCancel: boolean;
      cancelling: boolean;
      cancelError: string | null;
    }
  | {
      kind: "done";
      result: SplitSpeakersResult;
      /** Length of the recording each track plays, when known. */
      durationSec: number | null;
      /** Undo reverses this split only while it is the latest change. */
      canUndo: boolean;
      undoing: boolean;
      undoError: string | null;
    }
  | { kind: "failed"; reason: string }
  | { kind: "cancelled" };

export type SplitSpeakersDialogViewProps = {
  open: boolean;
  onClose: () => void;
  /** Label of the track being split. */
  trackLabel: string;
  stage: SplitSpeakersStage;
  onCountChange: (count: string) => void;
  onNameChange: (index: number, name: string) => void;
  onSplit: () => void;
  onCancelSplit: () => void;
  onUndo: () => void;
  /** Back to the settings after a failure, a cancel or an undo. */
  onRestart: () => void;
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
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Split speakers"
      panelClassName="bounce-dialog-panel split-speakers-panel"
      phoneSheet
      initialFocusRef={stage.kind === "configure" ? countRef : undefined}
      footer={<SplitSpeakersFooter {...props} />}
    >
      <div className="bounce-dialog-body">
        {stage.kind === "configure" ? (
          <SplitSpeakersForm {...props} countRef={countRef} />
        ) : null}
        {stage.kind === "running" ? (
          <SplitSpeakersProgress stage={stage} nowSec={props.nowSec} />
        ) : null}
        {stage.kind === "done" ? (
          <SplitSpeakersOutcome stage={stage} trackLabel={props.trackLabel} />
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

function SplitSpeakersForm({
  stage,
  trackLabel,
  onCountChange,
  onNameChange,
  countRef,
}: SplitSpeakersDialogViewProps & {
  countRef: RefObject<HTMLInputElement | null>;
}) {
  const namesHintId = useId();
  if (stage.kind !== "configure") {
    return null;
  }
  const count = Number(stage.count);
  const shown = Number.isInteger(count)
    ? Math.min(Math.max(count, MIN_SPLIT_SPEAKERS), MAX_SPLIT_SPEAKERS)
    : MIN_SPLIT_SPEAKERS;
  return (
    <>
      <p className="export-dialog-lead">
        Splits {trackLabel} into one track per speaker. Each track plays the
        same recording and goes quiet where someone else is talking, so together
        they sound like the original. Undo puts the single track back.
      </p>
      <Field
        label="Number of speakers"
        hint="Count everyone who talks. A number that is too high splits one voice in two."
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
      <fieldset className="split-speakers-names" aria-describedby={namesHintId}>
        <legend>Names (optional)</legend>
        <p id={namesHintId} className="ui-field-hint">
          A blank name becomes Speaker 1, Speaker 2, and so on, in the order
          they first talk.
        </p>
        <div className="split-speakers-name-grid">
          {Array.from({ length: shown }, (_, i) => (
            <Field key={i} label={`Speaker ${i + 1}`}>
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
          ))}
        </div>
      </fieldset>
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
        headline={stage.cancelling ? "Cancelling…" : undefined}
        unit={null}
        barLabel="Split progress"
        startingCopy="Starting the split…"
        nowSec={nowSec}
      />
      <p className="export-dialog-note">
        You can close this window. The split keeps going, and the status bar
        shows its progress. A long recording takes a few minutes.
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
}: {
  stage: Extract<SplitSpeakersStage, { kind: "done" }>;
  trackLabel: string;
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
        <ul className="split-speakers-notes" aria-label="Listen for">
          {notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
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
}: SplitSpeakersDialogViewProps) {
  const blockerId = useId();
  return (
    <div className="bounce-dialog-footer">
      {stage.kind === "configure" && stage.blocker ? (
        <p id={blockerId} className="export-dialog-note">
          {stage.blocker}
        </p>
      ) : null}
      <div className="bounce-dialog-actions split-speakers-actions">
        {stage.kind === "configure" ? (
          <Button
            variant="primary"
            type="button"
            disabled={stage.blocker != null}
            aria-describedby={stage.blocker ? blockerId : undefined}
            onClick={onSplit}
          >
            Split speakers
          </Button>
        ) : null}
        {stage.kind === "running" ? (
          <Button
            type="button"
            disabled={!stage.canCancel}
            onClick={onCancelSplit}
          >
            {stage.cancelling ? "Cancelling…" : "Cancel split"}
          </Button>
        ) : null}
        {stage.kind === "done" ? (
          <>
            {stage.canUndo ? (
              <Button type="button" disabled={stage.undoing} onClick={onUndo}>
                {stage.undoing ? "Undoing…" : "Undo split"}
              </Button>
            ) : null}
            <Button variant="primary" type="button" onClick={onClose}>
              Done
            </Button>
          </>
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
