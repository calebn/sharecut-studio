import { useEffect, useRef, useState } from "react";
import { waiveTranscriptRefine } from "../api";
import { Button } from "../ui";
import { BUSY_REASON } from "../ui/disabledReason";
import {
  errorMessage,
  TRANSCRIPT_REFINE_REQUIRED_CODE,
} from "../utils/apiError";

/** The reason saved when the host chooses Cut anyway; the host types nothing. */
export const CUT_ANYWAY_REASON = "Cut anyway, chosen by the host";

export const REFINE_GATE_GUI_MESSAGE =
  "The transcript isn't checked yet. Cut anyway, or check it first.";

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
    setBusy(true);
    setFormError(null);
    try {
      await waiveTranscriptRefine(projectPath, CUT_ANYWAY_REASON);
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
      {formError ? <p role="alert">{formError}</p> : null}
      <Button
        disabledReason={busy ? BUSY_REASON : undefined}
        onClick={() => void submit()}
      >
        Cut anyway
      </Button>
    </section>
  );
}
