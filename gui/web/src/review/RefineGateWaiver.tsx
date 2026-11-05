import { useLayoutEffect, useRef } from "react";
import { TranscriptRefineRecovery } from "../inspector/TranscriptRefineRecovery";
import { TRANSCRIPT_REFINE_REQUIRED_CODE } from "../utils/apiError";

const REFINE_WAIVED_MESSAGE =
  "Waiver recorded. Retry approval to apply pending edits.";

/** The Cut anyway prompt for a refine-gate refusal; once recorded, a status line that takes focus. */
export function RefineGateWaiver({
  projectPath,
  reason,
  waived,
  onWaived,
}: {
  projectPath: string;
  reason: string;
  waived: boolean;
  onWaived: () => void;
}) {
  const statusRef = useRef<HTMLParagraphElement>(null);
  const wasWaived = useRef(waived);
  useLayoutEffect(() => {
    if (waived && !wasWaived.current) statusRef.current?.focus();
    wasWaived.current = waived;
  }, [waived]);
  if (waived)
    return (
      <p ref={statusRef} role="status" tabIndex={-1}>
        {REFINE_WAIVED_MESSAGE}
      </p>
    );
  return (
    <TranscriptRefineRecovery
      projectPath={projectPath}
      error={reason}
      errorCode={TRANSCRIPT_REFINE_REQUIRED_CODE}
      onRecovered={onWaived}
    />
  );
}
