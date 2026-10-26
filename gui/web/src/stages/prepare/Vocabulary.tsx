import { useId } from "react";
import { ChipInput } from "../../system/ChipInput";
import { Button } from "../../ui";

export type VocabularyProps = {
  /** People from the Source cards, shown first and not removable here. */
  speakers: readonly string[];
  terms: readonly string[];
  /** Called on every change; there is no Save button. */
  onTermsChange: (terms: string[]) => void;
  /** Transcription has already run, so a new term needs another pass. */
  needsRetranscribe?: boolean;
  onRetranscribe?: () => void;
  /** Characters already spent elsewhere, such as the show title. */
  reservedChars?: number;
  /** Render the "Help the transcriber" h2. Prepare draws its own, so it turns this off. */
  heading?: boolean;
};

/**
 * Names and terms to listen for: speaker chips first, then the terms someone
 * adds. It saves on every change. When transcription has already run, a line
 * under the field says changes wait for the next pass and offers the button
 * that runs it.
 */
export function Vocabulary({
  speakers,
  terms,
  onTermsChange,
  needsRetranscribe = false,
  onRetranscribe,
  reservedChars,
  heading = true,
}: VocabularyProps) {
  const titleId = useId();
  const body = (
    <>
      <ChipInput
        speakers={speakers}
        terms={terms}
        onTermsChange={onTermsChange}
        reservedChars={reservedChars}
      />
      {needsRetranscribe ? (
        <div className="sys-vocab-again">
          <p className="sys-prepare-note">
            Applies next time words are transcribed.
          </p>
          <Button onClick={onRetranscribe}>Re-transcribe</Button>
        </div>
      ) : null}
    </>
  );
  if (!heading) return <div className="sys-vocab">{body}</div>;
  return (
    <section className="sys-vocab" aria-labelledby={titleId}>
      <h2 id={titleId} className="sys-prepare-title">
        Help the transcriber
      </h2>
      {body}
    </section>
  );
}
