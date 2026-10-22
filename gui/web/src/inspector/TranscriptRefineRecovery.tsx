import { useEffect, useRef, useState } from "react";
import { waiveTranscriptRefine } from "../api";
import { Button, Field } from "../ui";
import { BUSY_REASON } from "../ui/disabledReason";
import {
  errorMessage,
  TRANSCRIPT_REFINE_REQUIRED_CODE,
} from "../utils/apiError";

export const REFINE_GATE_GUI_MESSAGE =
  "Transcript refinement is required before approval. Review the transcript or waive with a reason below.";

type Props = {
  projectPath: string;
  error: string | null | undefined;
  errorCode: string | null;
  onRecovered: () => void;
};

/** Host-only recovery for an approval blocked by the transcript-refine gate. */
export function TranscriptRefineRecovery({
  projectPath,
  error,
  errorCode,
  onRecovered,
}: Props) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [recovered, setRecovered] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  const gated = errorCode === TRANSCRIPT_REFINE_REQUIRED_CODE;

  // A sheet that scrolls its body must not hide the form the refusal just opened.
  useEffect(() => {
    if (gated) sectionRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [gated]);

  if (errorCode !== TRANSCRIPT_REFINE_REQUIRED_CODE) {
    return recovered && !error ? (
      <p role="status">
        Waiver recorded. Retry approval to apply pending edits.
      </p>
    ) : null;
  }

  const submit = async () => {
    const trimmed = reason.trim();
    if (!trimmed) {
      setFormError("A reason is required to waive transcript refinement.");
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      await waiveTranscriptRefine(projectPath, trimmed);
      setReason("");
      setRecovered(true);
      onRecovered();
    } catch (cause) {
      setFormError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      ref={sectionRef}
      className="transcript-refine-recovery"
      aria-label="Transcript refine recovery"
    >
      <Field
        label="Waiver reason"
        hint="This reason is saved with the transcript-refine status."
        error={formError}
      >
        {(control) => (
          <textarea
            {...control}
            value={reason}
            rows={3}
            disabled={busy}
            onChange={(event) => setReason(event.target.value)}
          />
        )}
      </Field>
      <Button
        disabledReason={busy ? BUSY_REASON : undefined}
        onClick={() => void submit()}
      >
        Waive with reason
      </Button>
    </section>
  );
}
