import { useId } from "react";
import { runPointerCommand } from "../commands/pointer";
import { useHoldRepeat } from "../hooks/useHoldRepeat";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import { Button } from "../ui";
import { findTranscriptWord, transcriptSpanText } from "../utils/transcript";
import {
  RANGE_STEP_CONTROLS,
  type RangeStep,
  stepWordSpan,
  type TranscriptRangeSelection,
  wordCountOf,
} from "./rangeSelect";

const PREVIEW_CHARS = 72;

function preview(text: string | null): string | null {
  if (!text) return null;
  return text.length > PREVIEW_CHARS
    ? `${text.slice(0, PREVIEW_CHARS - 1)}…`
    : text;
}

/** Whether the live selection can move this edge, read at press time so a held repeat sees each step's result. */
function canStepNow(step: RangeStep): boolean {
  const { project, selection } = useDawStore.getState();
  if (!project || selection?.kind !== "transcriptRange") return false;
  return stepWordSpan(
    selection,
    step,
    (wordIndex) =>
      findTranscriptWord(project, selection.trackId, wordIndex) !== null,
  ).ok;
}

function StepButton({
  label,
  step,
  reason,
  reasonId,
}: {
  label: string;
  step: RangeStep;
  reason: string | null;
  reasonId: string;
}) {
  const hold = useHoldRepeat(() => {
    if (!canStepNow(step)) return false;
    runPointerCommand("transcript.extendRange", step);
    return true;
  });
  return (
    <Button
      type="button"
      disabled={reason !== null}
      aria-describedby={reason ? reasonId : undefined}
      {...hold}
      className={`ui-control--compact range-word-step ${hold.className}`}
    >
      {label}
    </Button>
  );
}

/**
 * Grow or trim the selected word range one word at a time: the long-press
 * drag's route as plain buttons. A hold repeats and a keyboard presses.
 */
export function WordRangeControls({
  selection,
}: {
  selection: TranscriptRangeSelection;
}) {
  const reasonId = useId();
  const project = useDaw((s) => s.project);
  if (!project) return null;
  const exists = (wordIndex: number) =>
    findTranscriptWord(project, selection.trackId, wordIndex) !== null;
  const rows = RANGE_STEP_CONTROLS.map(({ step, label }) => {
    const result = stepWordSpan(selection, step, exists);
    return { step, label, reason: result.ok ? null : result.reason };
  });
  const reasons = [...new Set(rows.map((row) => row.reason).filter(Boolean))];
  const count = wordCountOf(selection);
  const text = preview(
    transcriptSpanText(
      project,
      selection.trackId,
      selection.startWordIndex,
      selection.endWordIndex,
    ),
  );
  return (
    <div className="range-words" role="group" aria-label="Words in range">
      <p className="range-words-summary">
        {count === 1 ? "1 word" : `${count} words`}
        {text ? <span className="range-words-text"> · “{text}”</span> : null}
      </p>
      <div className="range-words-buttons">
        {rows.map((row) => (
          <StepButton
            key={`${row.step.edge}${row.step.by}`}
            label={row.label}
            step={row.step}
            reason={row.reason}
            reasonId={reasonId}
          />
        ))}
      </div>
      {reasons.length > 0 ? (
        <small id={reasonId} className="range-words-reason">
          {reasons.join(" ")}
        </small>
      ) : null}
    </div>
  );
}
