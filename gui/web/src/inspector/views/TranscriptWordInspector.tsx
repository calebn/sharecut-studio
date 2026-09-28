import { useId, useMemo, useState } from "react";
import {
  setTranscriptWordSuppressed,
  setTranscriptWordsIgnored,
} from "../../api";
import { capabilityTooltip } from "../../capabilities/copy";
import { useMountedRef } from "../../hooks/useMountedRef";
import { useProjectMutation } from "../../hooks/useProjectMutation";
import { isShareProjectKey } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { useDaw } from "../../state/useDaw";
import {
  type DetachedWordAction,
  reportDetachedWordFailure,
} from "../../transcript/detachedWordFailure";
import { isLowConfidenceWord } from "../../transcript/lowConfidence";
import {
  TRANSCRIPT_CORRECT_CONFLICT_NOTE,
  TRANSCRIPT_CORRECT_TIMING_NOTE,
  TRANSCRIPT_SPAN_UNVERIFIED_NOTE,
  TRANSCRIPT_SUPPRESS_TIP,
  TRANSCRIPT_UNSUPPRESS_TIP,
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
  InspectorSeekFooter,
} from "../../ui";
import { ApiError } from "../../utils/apiError";
import {
  findTranscriptWord,
  spanTextFromIndex,
  type TrackWordTexts,
  trackWordTexts,
  transcriptSpanText,
  wordSeekSec,
} from "../../utils/transcript";
import { ModifierInspector } from "../ModifierInspector";

/** Empty `TrackWordTexts` while transcript words are not hydrated yet. */
const NO_WORD_TEXTS: TrackWordTexts = new Map();

/** Successful Applies the inspector remembers for following its own Undo/Redo (#746). */
const APPLIED_CORRECTIONS_KEPT = 20;

export function TranscriptWordInspector({
  trackId,
  wordIndex,
  embedded = false,
}: {
  trackId: string;
  wordIndex: number;
  /** Docked inside TranscriptPanel (text focus) — not the side rail. */
  embedded?: boolean;
}) {
  const { project, projectPath } = useDaw((s) => ({
    project: s.project,
    projectPath: s.projectPath,
  }));
  const wordsHydrated = project?.meta.hydration?.transcript_words !== false;
  const word = useMemo(
    () =>
      project && wordsHydrated
        ? findTranscriptWord(project, trackId, wordIndex)
        : null,
    [project, trackId, wordIndex, wordsHydrated],
  );
  // Word texts on this track under the shared duplicate-index rule (#650): a
  // disagreeing duplicate maps to null. `findTranscriptWord` stays
  // first-listing for display only. Built once per project snapshot so
  // `changeEndIndex` below is O(span), not a full transcript scan per
  // keystroke.
  const wordTexts = useMemo(
    () =>
      project && wordsHydrated
        ? trackWordTexts(project, trackId)
        : NO_WORD_TEXTS,
    [project, trackId, wordsHydrated],
  );
  const wordSpanText = spanTextFromIndex(wordTexts, wordIndex, wordIndex);
  const { busy, error, setError, run } = useProjectMutation();
  const mountedRef = useMountedRef();

  // Seed the draft once, when the word first loads: on mount, or on
  // hydration if the words were not loaded yet. Never on a text change, so a
  // peer's edit to the anchor word, or our own successful Apply, cannot
  // clobber a draft in progress (#746). Both parents key this inspector by
  // `${trackId}:${wordIndex}` (`inspector/Inspector.tsx`,
  // `panels/TranscriptPanel.tsx`), so a different word remounts it rather
  // than re-seeding here. Unlike the other inspector views, which re-seed in
  // an effect, this seeds during render (React's "adjust state while
  // rendering" pattern), so the first frame with the word loaded already
  // shows its text and guards Apply with its span text instead of committing
  // an empty draft and a null baseline.
  const [text, setText] = useState(() => word?.text ?? "");
  const [endIndexStr, setEndIndexStr] = useState(() => String(wordIndex));
  // Span text the user saw when the draft was seeded or End index last
  // changed (#650). Apply sends this snapshot, never a fresh read, so a peer
  // edit inside the range since then is refused with a 409.
  const [expectedText, setExpectedText] = useState<string | null>(
    () => wordSpanText,
  );
  const [seeded, setSeeded] = useState(() => word != null);
  if (!seeded && word != null) {
    setSeeded(true);
    setText(word.text);
    setExpectedText(wordSpanText);
  }

  // Each successful Apply as (span it replaced, span it wrote), so an Undo
  // or Redo of our own correction moves the baseline with the words instead
  // of failing the next Apply with a 409 that blames someone else (#746). An
  // Apply sent unguarded is recorded with a null before text.
  const [appliedCorrections, setAppliedCorrections] = useState<
    readonly AppliedCorrection[]
  >([]);
  const endIndexNum = Number.parseInt(endIndexStr, 10);
  if (!busy && expectedText != null) {
    const restored = reconciledCorrectionBaseline(
      wordTexts,
      wordIndex,
      { endWordIndex: endIndexNum, text: expectedText },
      appliedCorrections,
    );
    if (restored) {
      setEndIndexStr(String(restored.endWordIndex));
      setExpectedText(restored.text);
    }
  }

  const changeEndIndex = (value: string) => {
    setEndIndexStr(value);
    setExpectedText(
      spanTextFromIndex(wordTexts, wordIndex, Number.parseInt(value, 10)),
    );
  };

  const editable = !isShareProjectKey(projectPath);
  const suppressed = Boolean(word?.suppressed);
  const ignored = Boolean(word?.ignored);
  const lowConf = word != null && isLowConfidenceWord(word);
  const hintId = useId();

  /**
   * Run one action on this word. Parents key this inspector per word, so a
   * failure that settles after it unmounted (the selection moved, e.g. a
   * low-confidence walkthrough step) goes to the transcript's late-failure
   * banner instead of being lost or shown under the next word.
   */
  const runForWord = async (
    action: DetachedWordAction,
    fn: () => Promise<unknown>,
  ): Promise<{ failed: boolean; failure: unknown }> => {
    const before = { text: word?.text ?? "", suppressed, ignored };
    let failure: unknown;
    let failed = false;
    await run(async () => {
      try {
        await fn();
      } catch (e) {
        failed = true;
        failure = e;
        throw e;
      }
    });
    if (failed && !mountedRef.current) {
      reportDetachedWordFailure({
        projectPath,
        trackId,
        wordIndex,
        word: before,
        action,
        failure,
      });
    }
    return { failed, failure };
  };

  const applyText = async () => {
    const endIndex = Number.parseInt(endIndexStr, 10);
    const problem = wordCorrectionError(text, wordIndex, endIndex);
    if (problem) {
      setError(problem);
      return;
    }
    const { failed, failure } = await runForWord("fix", () =>
      submitWordCorrection(
        projectPath,
        trackId,
        wordIndex,
        endIndex,
        text,
        expectedText,
      ),
    );
    if (!failed) {
      // Re-seed the baseline from what the server actually wrote (#746). The
      // typed draft (`text`) is kept. `appliedCorrectionSpan` predicts the new
      // End index; the baseline text is read from the store, which
      // `applyDocumentResult` already updated with the host's result, so it
      // does not depend on the JS and Python tokenizers agreeing. If the store
      // does not read as the predicted text (tokenizer drift, or a queued
      // offline send with no result yet), the baseline is null and the
      // unverified-span hint shows.
      const applied = appliedCorrectionSpan(wordIndex, endIndex, text);
      const stored = transcriptSpanText(
        useDawStore.getState().project,
        trackId,
        wordIndex,
        applied.endWordIndex,
      );
      const baseline = stored === applied.text ? stored : null;
      setEndIndexStr(String(applied.endWordIndex));
      setExpectedText(baseline);
      if (baseline != null) {
        const before = { endWordIndex: endIndex, text: expectedText };
        const after = { endWordIndex: applied.endWordIndex, text: baseline };
        setAppliedCorrections((prev) =>
          [...prev, { before, after }].slice(-APPLIED_CORRECTIONS_KEPT),
        );
      }
      return;
    }
    if (failure instanceof ApiError && failure.status === 409) {
      // The server refused because the span changed since we last snapshot
      // it. `correctTranscriptWord` / `correctTranscriptPhrase` already loaded
      // the host's current words into the store before rethrowing, so
      // re-snapshot from the store — not `wordTexts`, which reflects this
      // render — and Apply again retries against it (#746).
      setExpectedText(
        transcriptSpanText(
          useDawStore.getState().project,
          trackId,
          wordIndex,
          endIndex,
        ),
      );
      setError(TRANSCRIPT_CORRECT_CONFLICT_NOTE);
    }
  };

  const toggleSuppress = async () => {
    await runForWord("suppressed", () =>
      setTranscriptWordSuppressed(
        projectPath,
        trackId,
        wordIndex,
        !suppressed,
        wordSpanText,
      ),
    );
  };

  const toggleIgnored = async () => {
    await runForWord("ignored", () =>
      setTranscriptWordsIgnored(
        projectPath,
        trackId,
        wordIndex,
        wordIndex,
        !ignored,
        wordSpanText,
      ),
    );
  };

  if (!wordsHydrated) {
    return embedded ? (
      <div className="transcript-docked-editor-missing">
        Loading transcript words…
      </div>
    ) : (
      <aside className="inspector">Loading transcript words…</aside>
    );
  }

  if (!word) {
    return embedded ? (
      <div className="transcript-docked-editor-missing">
        Transcript word not found
      </div>
    ) : (
      <aside className="inspector">Transcript word not found</aside>
    );
  }

  const seekSec = wordSeekSec(word) ?? word.timeline_start ?? word.start;
  const playStart = word.timeline_start ?? word.start;
  const playEnd = word.timeline_end ?? word.end;
  const spanUnverified =
    Number.isInteger(endIndexNum) &&
    endIndexNum >= wordIndex &&
    expectedText == null;

  return (
    <ModifierInspector
      badge="Word"
      title={word.text}
      subtitle={`${trackId} · index ${wordIndex}`}
      embedded={embedded}
      primaryActions={
        editable
          ? [
              {
                label: suppressed ? "Unsuppress" : "Suppress",
                variant: "default",
                disabled: busy,
                onClick: () => void toggleSuppress(),
                title: suppressed
                  ? TRANSCRIPT_UNSUPPRESS_TIP
                  : TRANSCRIPT_SUPPRESS_TIP,
              },
              {
                label: ignored ? "Restore" : "Ignore",
                variant: "primary",
                disabled: busy,
                onClick: () => void toggleIgnored(),
                title: capabilityTooltip("daw.transcript.ignore", {
                  pressed: ignored,
                }),
              },
            ]
          : undefined
      }
      error={error}
      footer={
        <InspectorSeekFooter
          seekSec={seekSec}
          playStart={playStart}
          playEnd={playEnd}
          padSec={0.15}
          playLabel="Play word"
        />
      }
    >
      <DefinitionList>
        <DefItem label="Confidence">
          {word.confidence != null
            ? word.confidence.toFixed(2)
            : "Not available"}
          {lowConf ? " (low)" : ""}
        </DefItem>
        <DefItem label="Suppressed">{suppressed ? "yes" : "no"}</DefItem>
        <DefItem label="Ignored">{ignored ? "yes" : "no"}</DefItem>
        {editable ? (
          <>
            <DefItem label="Text">
              <FieldRow>
                <input
                  type="text"
                  value={text}
                  disabled={busy}
                  aria-label="Corrected text"
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void applyText();
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
                  aria-describedby={
                    editable && spanUnverified ? hintId : undefined
                  }
                  onChange={(e) => changeEndIndex(e.target.value)}
                  title="Same as start for a single-word correct; higher for phrase"
                />
                <Button disabled={busy} onClick={() => void applyText()}>
                  Apply
                </Button>
              </FieldRow>
            </DefItem>
          </>
        ) : null}
      </DefinitionList>
      {editable ? (
        <p className="ui-field-hint">{TRANSCRIPT_CORRECT_TIMING_NOTE}</p>
      ) : null}
      {editable ? (
        // Always mounted so screen readers announce the note when its text
        // appears; hidden (`sr-only`, out of the flex flow) while empty.
        <p
          id={hintId}
          className={spanUnverified ? "ui-field-hint" : "sr-only"}
          role="status"
        >
          {spanUnverified ? TRANSCRIPT_SPAN_UNVERIFIED_NOTE : null}
        </p>
      ) : null}
    </ModifierInspector>
  );
}
