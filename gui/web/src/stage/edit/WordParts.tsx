import {
  setTranscriptWordAutomatic,
  setTranscriptWordSuppressed,
} from "../../api";
import { TranscriptWordbar } from "../../transcript/TranscriptWordbar";
import {
  TRANSCRIPT_AUDIBILITY_LOCKED_TIP,
  TRANSCRIPT_RETURN_TO_AUTOMATIC_TIP,
  TRANSCRIPT_SUPPRESS_TIP,
  TRANSCRIPT_UNSUPPRESS_TIP,
} from "../../transcript/transcriptModeCopy";
import { Button, InlineError } from "../../ui";
import { BUSY_REASON } from "../../ui/disabledReason";
import { useTranscriptWord, useWordTarget, type WordRef } from "./wordTarget";

export function WordActions(ref: WordRef) {
  const t = useWordTarget(ref);
  const { word, wordSpanText, projectPath, busy, error, runForWord } = t;
  const { trackId, sourceId, wordIndex } = ref;
  if (!word) return null;
  const suppressed = Boolean(word.suppressed);
  const locked = Boolean(word.audibility_locked);
  const reason = busy ? BUSY_REASON : undefined;
  return (
    <div className="inspector edit-sheet-part">
      <div className="modifier-actions">
        <Button
          disabledReason={reason}
          title={
            suppressed ? TRANSCRIPT_UNSUPPRESS_TIP : TRANSCRIPT_SUPPRESS_TIP
          }
          onClick={() =>
            void runForWord(
              "suppressed",
              () =>
                setTranscriptWordSuppressed(
                  projectPath,
                  trackId,
                  wordIndex,
                  !suppressed,
                  wordSpanText,
                  sourceId,
                ),
              suppressed
                ? "Word put back in the transcript text"
                : "Word dropped from the transcript text",
            )
          }
        >
          {suppressed ? "Unsuppress" : "Suppress"}
        </Button>
      </div>
      {locked ? (
        <>
          <p className="ui-field-hint">{TRANSCRIPT_AUDIBILITY_LOCKED_TIP}</p>
          <Button
            disabledReason={reason}
            title={TRANSCRIPT_RETURN_TO_AUTOMATIC_TIP}
            onClick={() =>
              void (async () => {
                const { failed } = await runForWord(
                  "audibility_locked",
                  () =>
                    setTranscriptWordAutomatic(
                      projectPath,
                      trackId,
                      wordIndex,
                      wordSpanText,
                      sourceId,
                    ),
                  "Word back to automatic",
                );
                // The button is gone once the lock clears: keep focus in the sheet.
                if (!failed)
                  document
                    .querySelector<HTMLElement>("[data-inspector-anchor]")
                    ?.focus({ preventScroll: true });
              })()
            }
          >
            Return to automatic
          </Button>
        </>
      ) : null}
      <InlineError message={error} />
    </div>
  );
}

export function WordTiming(ref: WordRef) {
  const { word } = useTranscriptWord(ref);
  if (!word) return null;
  return (
    <div className="inspector edit-sheet-part">
      <TranscriptWordbar
        word={word}
        trackId={ref.trackId}
        wordIndex={ref.wordIndex}
      />
    </div>
  );
}
