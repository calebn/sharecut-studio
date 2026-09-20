import { useId } from "react";
import { Button } from "../ui";
import type { RoomToneStatus } from "./roomTone";
import {
  ROOM_TONE_CAPTURING_COPY,
  ROOM_TONE_DONE_COPY,
  ROOM_TONE_NOT_READY_COPY,
  ROOM_TONE_PROMPT_COPY,
  ROOM_TONE_TOO_LOUD_COPY,
} from "./types";

type Props = {
  status: RoomToneStatus;
  error: string | null;
  micReady: boolean;
  captureReady?: boolean;
  onRecord: () => void;
  onSkip: () => void;
  onRetry: () => void;
};

export function RoomToneCapture({
  status,
  error,
  micReady,
  captureReady = true,
  onRecord,
  onSkip,
  onRetry,
}: Props) {
  const headingId = useId();
  const hintId = useId();
  const micReasonId = useId();
  const capturingId = useId();
  const notReadyId = useId();
  const busy = status === "capturing";
  const hookReady = micReady && captureReady;
  const canRecord = hookReady && !busy;
  const showRetry = status === "too_loud" || status === "error";
  const describedBy = !micReady
    ? micReasonId
    : !captureReady
      ? notReadyId
      : busy
        ? capturingId
        : hintId;
  return (
    <section className="stack" aria-labelledby={headingId} aria-busy={busy}>
      <h2 id={headingId}>{ROOM_TONE_PROMPT_COPY}</h2>
      <p id={hintId}>
        Optional quiet bed for filler pads. Skip if the room is noisy.
      </p>
      <div className="cluster">
        <Button
          variant="primary"
          type="button"
          onClick={onRecord}
          disabled={!canRecord}
          aria-describedby={!canRecord ? describedBy : undefined}
        >
          {busy ? ROOM_TONE_CAPTURING_COPY : "Record room tone"}
        </Button>
        <Button type="button" onClick={onSkip}>
          Skip
        </Button>
        {showRetry ? (
          <Button type="button" onClick={onRetry} disabled={busy}>
            Retry
          </Button>
        ) : null}
      </div>
      <div aria-live="polite">
        {busy ? <p id={capturingId}>{ROOM_TONE_CAPTURING_COPY}</p> : null}
        {status === "too_loud" ? (
          <p className="record-warn">{ROOM_TONE_TOO_LOUD_COPY}</p>
        ) : null}
        {status === "recorded" ? <p>{ROOM_TONE_DONE_COPY}</p> : null}
        {status === "skipped" ? <p>Skipped room tone.</p> : null}
        {error ? <p className="record-warn">{error}</p> : null}
        {!micReady ? (
          <p id={micReasonId} className="record-warn">
            Allow the microphone before recording room tone.
          </p>
        ) : null}
        {micReady && !captureReady ? (
          <p id={notReadyId} className="record-warn">
            {ROOM_TONE_NOT_READY_COPY}
          </p>
        ) : null}
      </div>
    </section>
  );
}
