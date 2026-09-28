import { useEffect, useMemo, useState } from "react";
import {
  setTranscriptWordSuppressed,
  setTranscriptWordsIgnored,
} from "../../api";
import { capabilityTooltip } from "../../capabilities/copy";
import { useMountedRef } from "../../hooks/useMountedRef";
import { useProjectMutation } from "../../hooks/useProjectMutation";
import { isShareProjectKey } from "../../shareMode";
import { useDaw } from "../../state/useDaw";
import {
  type DetachedWordAction,
  reportDetachedWordFailure,
} from "../../transcript/detachedWordFailure";
import { isLowConfidenceWord } from "../../transcript/lowConfidence";
import {
  TRANSCRIPT_CORRECT_TIMING_NOTE,
  TRANSCRIPT_SUPPRESS_TIP,
  TRANSCRIPT_UNSUPPRESS_TIP,
} from "../../transcript/transcriptModeCopy";
import {
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
import {
  findTranscriptWord,
  transcriptSpanText,
  wordSeekSec,
} from "../../utils/transcript";
import { ModifierInspector } from "../ModifierInspector";

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
  const { busy, error, setError, run } = useProjectMutation();
  const mountedRef = useMountedRef();
  const [text, setText] = useState(word?.text ?? "");
  const [endIndexStr, setEndIndexStr] = useState(String(wordIndex));

  useEffect(() => {
    setText(word?.text ?? "");
    setEndIndexStr(String(wordIndex));
    setError(null);
  }, [word?.text, wordIndex, trackId, setError]);

  const editable = !isShareProjectKey(projectPath);
  const suppressed = Boolean(word?.suppressed);
  const ignored = Boolean(word?.ignored);
  const lowConf = word != null && isLowConfidenceWord(word);

  /**
   * Run one action on this word. Parents key this inspector per word, so a
   * failure that settles after it unmounted (the selection moved, e.g. a
   * low-confidence walkthrough step) goes to the transcript's late-failure
   * banner instead of being lost or shown under the next word.
   */
  const runForWord = async (
    action: DetachedWordAction,
    fn: () => Promise<unknown>,
  ) => {
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
  };

  const applyText = async () => {
    const endIndex = Number.parseInt(endIndexStr, 10);
    const problem = wordCorrectionError(text, wordIndex, endIndex);
    if (problem) {
      setError(problem);
      return;
    }
    const expectedText = transcriptSpanText(
      project,
      trackId,
      wordIndex,
      endIndex,
    );
    await runForWord("fix", () =>
      submitWordCorrection(
        projectPath,
        trackId,
        wordIndex,
        endIndex,
        text,
        expectedText,
      ),
    );
  };

  const toggleSuppress = async () => {
    await runForWord("suppressed", () =>
      setTranscriptWordSuppressed(projectPath, trackId, wordIndex, !suppressed),
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
                  onChange={(e) => setEndIndexStr(e.target.value)}
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
    </ModifierInspector>
  );
}
