import { useEffect, useRef, useState } from "react";
import { Button, InlineConfirm } from "../ui";
import { STOP_CONFIRM_COPY } from "./hostControls";

type Props = {
  /** A record command is in flight: Stop stays focusable but ignores presses. */
  busy: boolean;
  onStop: () => void;
};

/**
 * Stop sits in its own row and asks once before it ends the take for everyone.
 * The question is the shared `ui/InlineConfirm` (Keep first and focused, the
 * danger action last); focus returns to Stop when the question closes.
 */
export function StopTakeControl({ busy, onStop }: Props) {
  const [confirming, setConfirming] = useState(false);
  const stopRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);

  useEffect(() => {
    if (!confirming && returnFocus.current) {
      returnFocus.current = false;
      stopRef.current?.focus();
    }
  }, [confirming]);

  function close() {
    returnFocus.current = true;
    setConfirming(false);
  }

  return (
    <div className="record-stop">
      {confirming ? (
        <InlineConfirm
          prompt={STOP_CONFIRM_COPY}
          keepLabel="Keep recording"
          actionLabel="Stop take"
          disabled={busy}
          onKeep={close}
          onConfirm={() => {
            close();
            onStop();
          }}
        />
      ) : (
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
      )}
    </div>
  );
}
