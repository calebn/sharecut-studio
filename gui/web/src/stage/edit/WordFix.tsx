import { useEffect, useId, useRef, useState } from "react";
import { useDawStore } from "../../state/dawStore";
import { useDaw } from "../../state/useDaw";
import {
  TRANSCRIPT_CORRECT_CONFLICT_NOTE,
  TRANSCRIPT_CORRECT_TIMING_NOTE,
  TRANSCRIPT_SPAN_UNVERIFIED_NOTE,
} from "../../transcript/transcriptModeCopy";
import {
  type AppliedCorrection,
  appliedCorrectionSpan,
  reconciledCorrectionBaseline,
  submitWordCorrection,
  wordCorrectionError,
} from "../../transcript/wordCorrection";
import {
  Button,
  DefItem,
  DefinitionList,
  FieldRow,
  InlineError,
} from "../../ui";
import { BUSY_REASON } from "../../ui/disabledReason";
import { ApiError } from "../../utils/apiError";
import { spanTextFromIndex, transcriptSpanText } from "../../utils/transcript";
import { useWordTarget, type WordRef } from "./wordTarget";

/** Successful Applies the form remembers for following its own Undo/Redo (#746). */
const APPLIED_CORRECTIONS_KEPT = 20;

/**
 * The editable Text and End index of one word. Typed but unsaved fields
 * outlive this component: a rotation swaps the shell and remounts it (#1885),
 * so they are mirrored into the store's `wordDraft`.
 */
export function WordFix({ trackId, sourceId, wordIndex }: WordRef) {
  const target = useWordTarget({ trackId, sourceId, wordIndex });
  const { word, wordTexts, wordSpanText, projectPath, busy, error } = target;
  const projectEpoch = useDaw((s) => s.projectEpoch);
  const hintId = useId();
  const [restored] = useState(() => {
    const entry = useDawStore.getState().wordDraft;
    return entry &&
      entry.projectPath === projectPath &&
      entry.projectEpoch === projectEpoch &&
      entry.trackId === trackId &&
      entry.sourceId === sourceId &&
      entry.wordIndex === wordIndex
      ? entry
      : null;
  });
  const [text, setText] = useState(() => restored?.text ?? word?.text ?? "");
  const [endIndexStr, setEndIndexStr] = useState(
    () => restored?.endIndexStr ?? String(wordIndex),
  );
  // Span text the user saw when the draft was seeded or End index last
  // changed (#650). Apply sends this snapshot, never a fresh read, so a peer
  // edit inside the range since then is refused with a 409.
  const [expectedText, setExpectedText] = useState<string | null>(() =>
    restored ? restored.expectedText : wordSpanText,
  );

  // Each successful Apply as (span it replaced, span it wrote), so an Undo or
  // Redo of our own correction moves the baseline with the words instead of
  // failing the next Apply with a 409 that blames someone else (#746).
  const [applied, setApplied] = useState<readonly AppliedCorrection[]>([]);
  const endIndexNum = Number.parseInt(endIndexStr, 10);
  if (!busy && expectedText != null) {
    const back = reconciledCorrectionBaseline(
      wordTexts,
      wordIndex,
      { endWordIndex: endIndexNum, text: expectedText },
      applied,
    );
    if (back) {
      setEndIndexStr(String(back.endWordIndex));
      setExpectedText(back.text);
    }
  }

  // Only a form the person is editing (typed in or applied since its fields
  // last matched the saved word) writes the slot; a restored one only reads it.
  const touched = useRef(false);
  const dirty =
    text !== (word?.text ?? text) || endIndexStr !== String(wordIndex);
  useEffect(() => {
    if (!touched.current) return;
    const store = useDawStore.getState();
    const mine = store.wordDraft;
    const isMine =
      mine != null &&
      mine.projectPath === projectPath &&
      mine.projectEpoch === projectEpoch &&
      mine.trackId === trackId &&
      mine.sourceId === sourceId &&
      mine.wordIndex === wordIndex;
    if (dirty) {
      store.setWordDraft({
        projectPath,
        projectEpoch,
        trackId,
        sourceId,
        wordIndex,
        text,
        endIndexStr,
        expectedText,
      });
    } else {
      if (isMine) store.setWordDraft(null);
      touched.current = false;
    }
  }, [
    dirty,
    text,
    endIndexStr,
    expectedText,
    projectPath,
    projectEpoch,
    trackId,
    sourceId,
    wordIndex,
  ]);

  const changeEndIndex = (value: string) => {
    touched.current = true;
    setEndIndexStr(value);
    setExpectedText(
      spanTextFromIndex(wordTexts, wordIndex, Number.parseInt(value, 10)),
    );
  };

  const apply = async () => {
    touched.current = true;
    const endIndex = Number.parseInt(endIndexStr, 10);
    const problem = wordCorrectionError(text, wordIndex, endIndex);
    if (problem) {
      target.setError(problem);
      return;
    }
    const { failed, failure } = await target.runForWord(
      "fix",
      () =>
        submitWordCorrection(
          projectPath,
          trackId,
          wordIndex,
          endIndex,
          text,
          expectedText,
          sourceId,
        ),
      endIndex === wordIndex ? "Word text fixed" : "Phrase text fixed",
    );
    if (!failed) {
      // Re-seed the baseline from what the server wrote (#746): the store
      // already holds the host's result. When it does not read as the
      // predicted text (tokenizer drift, a queued offline send) the baseline
      // is null and the unverified-span hint shows. The typed draft is kept.
      const span = appliedCorrectionSpan(wordIndex, endIndex, text);
      const stored = transcriptSpanText(
        useDawStore.getState().project,
        trackId,
        wordIndex,
        span.endWordIndex,
        sourceId,
      );
      const baseline = stored === span.text ? stored : null;
      setEndIndexStr(String(span.endWordIndex));
      setExpectedText(baseline);
      if (baseline != null) {
        const before = { endWordIndex: endIndex, text: expectedText };
        const after = { endWordIndex: span.endWordIndex, text: baseline };
        setApplied((prev) =>
          [...prev, { before, after }].slice(-APPLIED_CORRECTIONS_KEPT),
        );
      }
      return;
    }
    if (failure instanceof ApiError && failure.status === 409) {
      // The span changed since the snapshot; the correction already loaded
      // the host's words into the store, so re-snapshot from there (#746).
      const current = transcriptSpanText(
        useDawStore.getState().project,
        trackId,
        wordIndex,
        endIndex,
        sourceId,
      );
      setExpectedText(current);
      // Promise a retry only when the store now reads differently.
      if (current !== expectedText) {
        target.setError(TRANSCRIPT_CORRECT_CONFLICT_NOTE);
      }
    }
  };

  const spanUnverified =
    Number.isInteger(endIndexNum) &&
    endIndexNum >= wordIndex &&
    expectedText == null;
  return (
    <div className="inspector edit-sheet-part">
      <DefinitionList>
        <DefItem label="Text">
          <FieldRow>
            <input
              type="text"
              value={text}
              disabled={busy}
              aria-label="Corrected text"
              onChange={(e) => {
                touched.current = true;
                setText(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void apply();
                }
              }}
            />
          </FieldRow>
        </DefItem>
        <DefItem label="End index">
          <FieldRow>
            <input
              type="number"
              min={wordIndex}
              value={endIndexStr}
              disabled={busy}
              aria-label="End word index"
              aria-describedby={spanUnverified ? hintId : undefined}
              onChange={(e) => changeEndIndex(e.target.value)}
              title="Same as start for a single-word correct; higher for phrase"
            />
            <Button
              disabledReason={busy ? BUSY_REASON : undefined}
              onClick={() => void apply()}
            >
              Apply
            </Button>
          </FieldRow>
        </DefItem>
      </DefinitionList>
      <InlineError message={error} />
      <p className="ui-field-hint">{TRANSCRIPT_CORRECT_TIMING_NOTE}</p>
      {/* Always mounted so screen readers announce the note when its text appears. */}
      <p
        id={hintId}
        className={spanUnverified ? "ui-field-hint" : "sr-only"}
        role="status"
      >
        {spanUnverified ? TRANSCRIPT_SPAN_UNVERIFIED_NOTE : null}
      </p>
    </div>
  );
}
