import { useId, useState } from "react";
import { waiveTranscriptRefine } from "../api";
import { Button, Field } from "../ui";

const REFINE_GATE_PREFIX = "Transcript refine is required before";

type Props = {
  projectPath: string;
  error: string | null | undefined;
  onRecovered: () => void;
};

/** Host-only recovery for an approval blocked by the transcript-refine gate. */
export function TranscriptRefineRecovery({
  projectPath,
  error,
  onRecovered,
}: Props) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [recovered, setRecovered] = useState(false);
  const reasonId = useId();

  if (!error?.startsWith(REFINE_GATE_PREFIX)) {
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
        error={formError}
      >
        <textarea
          id={reasonId}
          value={reason}
          rows={3}
          disabled={busy}
          onChange={(event) => setReason(event.target.value)}
        />
      </Field>
      <Button disabled={busy} onClick={() => void submit()}>
        Waive with reason
      </Button>
    </section>
  );
}
