import { useId, useState } from "react";
import { waiveTranscriptRefine } from "../api";
import { Button, Field } from "../ui";
import { TRANSCRIPT_REFINE_REQUIRED_CODE } from "../utils/apiError";

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
  const reasonId = useId();
  const errorId = useId();

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
      setFormError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="transcript-refine-recovery"
      aria-label="Transcript refine recovery"
    >
      <p className="inspector-body">
        Approving is blocked until transcript refinement is done. If you have
        reviewed the transcript, record why it is safe to waive this gate.
      </p>
      <Field
        label="Waiver reason"
        htmlFor={reasonId}
        hint="This reason is saved with the transcript-refine status."
      >
        <textarea
          id={reasonId}
          value={reason}
          rows={3}
          disabled={busy}
          aria-invalid={Boolean(formError)}
          aria-describedby={formError ? errorId : undefined}
          onChange={(event) => setReason(event.target.value)}
        />
      </Field>
      {formError ? (
        <p id={errorId} className="inline-error pipeline-error" role="alert">
          {formError}
        </p>
      ) : null}
      <Button disabled={busy} onClick={() => void submit()}>
        Waive with reason
      </Button>
    </section>
  );
}
