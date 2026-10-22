import { useId } from "react";
import { Button } from "../ui";
import { BUSY_REASON } from "../ui/disabledReason";
import type { RoomToneDelivery, RoomToneStatus } from "./roomTone";
import {
  ROOM_TONE_CAPTURING_COPY,
  ROOM_TONE_DEVICE_COPY,
  ROOM_TONE_HOST_COPY,
  ROOM_TONE_NOT_READY_COPY,
  ROOM_TONE_PROMPT_COPY,
  ROOM_TONE_TOO_LOUD_COPY,
} from "./types";

type Props = {
  status: RoomToneStatus;
  /** Where a recorded bed is kept; a bed the host has not acknowledged stays on this device. */
  delivery?: RoomToneDelivery;
  error: string | null;
  micReady: boolean;
  captureReady?: boolean;
  onRecord: () => void;
  onSkip: () => void;
  onRetry: () => void;
  /** False where another control is the view's primary action (the host's Start). */
  primary?: boolean;
};

const MIC_REASON = "Allow the microphone before recording room tone.";

export function RoomToneCapture({
  status,
  delivery = "device",
  error,
  micReady,
  captureReady = true,
  onRecord,
  onSkip,
  onRetry,
  primary = true,
}: Props) {
  const headingId = useId();
  const busy = status === "capturing";
  const showRetry = status === "too_loud" || status === "error";
  return (
    <section className="stack" aria-labelledby={headingId} aria-busy={busy}>
      <h2 id={headingId}>{ROOM_TONE_PROMPT_COPY}</h2>
      <p>Optional quiet bed for filler pads. Skip if the room is noisy.</p>
      <div className="cluster">
        <Button
          variant={primary ? "primary" : "default"}
          type="button"
          onClick={onRecord}
          disabledReason={
            !micReady
              ? MIC_REASON
              : !captureReady
                ? ROOM_TONE_NOT_READY_COPY
                : busy
                  ? ROOM_TONE_CAPTURING_COPY
                  : undefined
          }
        >
          {busy ? ROOM_TONE_CAPTURING_COPY : "Record room tone"}
        </Button>
        <Button type="button" onClick={onSkip}>
          Skip
        </Button>
        {showRetry ? (
          <Button
            type="button"
            onClick={onRetry}
            disabledReason={busy ? BUSY_REASON : undefined}
          >
            Retry
          </Button>
        ) : null}
      </div>
      <div aria-live="polite">
        {busy ? <p>{ROOM_TONE_CAPTURING_COPY}</p> : null}
        {status === "too_loud" ? (
          <p className="record-warn">{ROOM_TONE_TOO_LOUD_COPY}</p>
        ) : null}
        {status === "recorded" ? (
          <p>
            {delivery === "host" ? ROOM_TONE_HOST_COPY : ROOM_TONE_DEVICE_COPY}
          </p>
        ) : null}
        {status === "skipped" ? <p>Skipped room tone.</p> : null}
        {error ? <p className="record-warn">{error}</p> : null}
        {!micReady ? <p className="record-warn">{MIC_REASON}</p> : null}
        {micReady && !captureReady ? (
          <p className="record-warn">{ROOM_TONE_NOT_READY_COPY}</p>
        ) : null}
      </div>
    </section>
  );
}
