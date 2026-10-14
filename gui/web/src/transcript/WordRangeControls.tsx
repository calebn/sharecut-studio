import { useId } from "react";
import { runPointerCommand } from "../commands/pointer";
import { useHoldRepeat } from "../hooks/useHoldRepeat";
import { isShareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import { Button } from "../ui";
import { CommandButton } from "../ui/CommandButton";
import { findTranscriptWord, transcriptSpanText } from "../utils/transcript";
import { selectionAllIgnored } from "./ignoredWords";
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
      findTranscriptWord(
        project,
        selection.trackId,
        wordIndex,
        selection.sourceId,
      ) !== null,
  ).ok;
}

function StepButton({
  label,
  step,
  reason,
}: {
  label: string;
  step: RangeStep;
  reason: string | null;
}) {
  const hold = useHoldRepeat(() => {
    if (!canStepNow(step)) return false;
    runPointerCommand("transcript.extendRange", step);
    return true;
  });
  return (
    <Button
      type="button"
      disabledReason={reason ?? undefined}
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
  const hostEditable = useDaw((s) => !isShareProjectKey(s.projectPath));
  if (!project) return null;
  const ignored = selectionAllIgnored(
    project,
    selection.trackId,
    selection.startWordIndex,
    selection.endWordIndex,
    selection.sourceId,
  );
  const exists = (wordIndex: number) =>
    findTranscriptWord(
      project,
      selection.trackId,
      wordIndex,
      selection.sourceId,
    ) !== null;
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
      selection.sourceId,
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
          />
        ))}
      </div>
      {hostEditable ? (
        <CommandButton
          commandId="transcript.ignoreWords"
          className="ui-control--compact range-word-ignore"
          disabledReason={
            project.meta.hydration?.transcript_words === false
              ? "Wait for the transcript to finish loading."
              : undefined
          }
        >
          {ignored ? "Restore" : "Ignore"}
        </CommandButton>
      ) : null}
      {reasons.length > 0 ? (
        <small id={reasonId} className="range-words-reason">
          {reasons.join(" ")}
        </small>
      ) : null}
    </div>
  );
}
