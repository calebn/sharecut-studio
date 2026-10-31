import {
  setTranscriptWordAutomatic,
  setTranscriptWordSuppressed,
  setTranscriptWordsIgnored,
} from "../../api";
import { capabilityTooltip } from "../../capabilities/copy";
import { isLowConfidenceWord } from "../../transcript/lowConfidence";
import { TranscriptWordbar } from "../../transcript/TranscriptWordbar";
import {
  TRANSCRIPT_AUDIBILITY_LOCKED_TIP,
  TRANSCRIPT_RETURN_TO_AUTOMATIC_TIP,
  TRANSCRIPT_SUPPRESS_TIP,
  TRANSCRIPT_UNSUPPRESS_TIP,
} from "../../transcript/transcriptModeCopy";
import {
  Button,
  DefItem,
  DefinitionList,
  InlineError,
  InspectorSeekFooter,
} from "../../ui";
import { BUSY_REASON } from "../../ui/disabledReason";
import { wordSeekSec } from "../../utils/transcript";
import { useWordTarget, type WordRef } from "./wordTarget";

/** Suppress, Ignore and Return to automatic: each answers with a toast and Undo. */
export function WordActions(ref: WordRef) {
  const t = useWordTarget(ref);
  const { word, wordSpanText, projectPath, busy, error, runForWord } = t;
  const { trackId, sourceId, wordIndex } = ref;
  if (!word) return null;
  const suppressed = Boolean(word.suppressed);
  const ignored = Boolean(word.ignored);
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
        <Button
          variant="primary"
          disabledReason={reason}
          title={capabilityTooltip("daw.transcript.ignore", {
            pressed: ignored,
          })}
          onClick={() =>
            void runForWord(
              "ignored",
              () =>
                setTranscriptWordsIgnored(
                  projectPath,
                  trackId,
                  wordIndex,
                  wordIndex,
                  !ignored,
                  wordSpanText,
                  sourceId,
                ),
              ignored ? "Restored word" : "Ignored word",
            )
          }
        >
          {ignored ? "Restore" : "Ignore"}
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

export function WordFacts(ref: WordRef) {
  const { word } = useWordTarget(ref);
  if (!word) return null;
  return (
    <div className="inspector edit-sheet-part">
      <DefinitionList>
        <DefItem label="Confidence">
          {word.confidence != null
            ? word.confidence.toFixed(2)
            : "Not available"}
          {isLowConfidenceWord(word) ? " (low)" : ""}
        </DefItem>
        <DefItem label="Suppressed">
          {word.suppressed ? "yes" : "no"}
          {word.audibility_locked ? " (locked)" : ""}
        </DefItem>
        <DefItem label="Ignored">{word.ignored ? "yes" : "no"}</DefItem>
      </DefinitionList>
    </div>
  );
}

export function WordTiming(ref: WordRef) {
  const { word } = useWordTarget(ref);
  if (!word) return null;
  return (
    <div className="inspector edit-sheet-part">
      <TranscriptWordbar
        word={word}
        trackId={ref.trackId}
        wordIndex={ref.wordIndex}
      />
      <footer className="modifier-footer">
        <InspectorSeekFooter
          seekSec={wordSeekSec(word) ?? word.timeline_start ?? word.start}
          playStart={word.timeline_start ?? word.start}
          playEnd={word.timeline_end ?? word.end}
          padSec={0.15}
          playLabel="Play word"
        />
      </footer>
    </div>
  );
}
