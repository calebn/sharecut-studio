import { useEffect, useId, useRef, useState } from "react";
import { Button } from "../ui";
import { STOP_CONFIRM_COPY } from "./hostControls";

type Props = {
  /** A record command is in flight: Stop stays focusable but ignores presses. */
  busy: boolean;
  onStop: () => void;
};

/**
 * Stop sits in its own row and asks once before it ends the take for everyone.
 * Focus moves to the safe choice when the question opens and back to Stop on Keep.
 */
export function StopTakeControl({ busy, onStop }: Props) {
  const [confirming, setConfirming] = useState(false);
  const promptId = useId();
  const stopRef = useRef<HTMLButtonElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);

  useEffect(() => {
    if (confirming) {
      keepRef.current?.focus();
    } else if (returnFocus.current) {
      returnFocus.current = false;
      stopRef.current?.focus();
    }
  }, [confirming]);

  if (!confirming) {
    return (
      <div className="record-stop">
        <Button
          ref={stopRef}
          variant="danger"
          aria-disabled={busy || undefined}
          onClick={() => {
            if (!busy) {
              setConfirming(true);
            }
          }}
        >
          Stop
        </Button>
      </div>
    );
  }
  return (
    <div className="record-stop" role="group" aria-labelledby={promptId}>
      <p id={promptId} className="record-stop-prompt">
        {STOP_CONFIRM_COPY}
      </p>
      <div className="cluster record-stop-actions">
        <Button
          ref={keepRef}
          onClick={() => {
            returnFocus.current = true;
            setConfirming(false);
          }}
        >
          Keep recording
        </Button>
        <Button
          variant="danger"
          aria-disabled={busy || undefined}
          onClick={() => {
            if (busy) {
              return;
            }
            returnFocus.current = true;
            setConfirming(false);
            onStop();
          }}
        >
          Stop take
        </Button>
      </div>
    </div>
  );
}
