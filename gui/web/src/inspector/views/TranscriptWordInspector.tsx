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
  TRANSCRIPT_CORRECT_TIMING_NOTE,
  TRANSCRIPT_SPAN_UNVERIFIED_NOTE,
  TRANSCRIPT_SUPPRESS_TIP,
  TRANSCRIPT_UNSUPPRESS_TIP,
} from "../../transcript/transcriptModeCopy";
import {
  appliedCorrectionSpan,
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

  // Seed the draft once per word — on hydration (word first loads) or when
  // the props name another word — guarded by `seededKey`, never on a text
  // change. That keeps a draft in progress (including one just applied, or
  // re-snapshotted after a 409 below) from being clobbered by a peer's edit
  // to the anchor word, or by our own successful Apply changing `word.text`
  // (#746).
  const seedKey = `${trackId}:${wordIndex}`;
  const [text, setText] = useState(() => word?.text ?? "");
  const [endIndexStr, setEndIndexStr] = useState(() => String(wordIndex));
  // Span text the user saw when the draft was seeded or End index last
  // changed (#650). Apply sends this snapshot, never a fresh read, so a peer
  // edit inside the range since then is refused with a 409.
  const [expectedText, setExpectedText] = useState<string | null>(
    () => wordSpanText,
  );
  const [seededKey, setSeededKey] = useState<string | null>(() =>
    word != null ? seedKey : null,
  );
  if (word != null && seededKey !== seedKey) {
    setSeededKey(seedKey);
    setText(word.text);
    setEndIndexStr(String(wordIndex));
    setExpectedText(wordSpanText);
    setError(null);
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
      // Re-seed from what the server actually wrote (#746). The typed draft
      // (`text`) is kept — this only moves the baseline End index / expected
      // text forward so the next Apply guards against the text just applied.
      const applied = appliedCorrectionSpan(wordIndex, endIndex, text);
      setEndIndexStr(String(applied.endWordIndex));
      setExpectedText(applied.text);
      return;
    }
    if (failure instanceof ApiError && failure.status === 409) {
      // The server refused because the span changed since we last snapshot
      // it. Re-snapshot from the store's current project — not `wordTexts`,
      // which reflects this render, not necessarily the update that caused
      // the 409 — and keep the error so Apply retries against it (#746).
      setExpectedText(
        transcriptSpanText(
          useDawStore.getState().project,
          trackId,
          wordIndex,
          endIndex,
        ),
      );
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
  const endIndexNum = Number.parseInt(endIndexStr, 10);
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
      {editable && spanUnverified ? (
        <p id={hintId} className="ui-field-hint" role="status">
          {TRANSCRIPT_SPAN_UNVERIFIED_NOTE}
        </p>
      ) : null}
    </ModifierInspector>
  );
}
