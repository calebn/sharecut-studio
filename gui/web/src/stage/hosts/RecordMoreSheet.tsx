import { type ComponentProps, useState } from "react";
import {
  type LandGate,
  ROOM_TONE_CAPTURING_COPY,
  ROOM_TONE_DEVICE_COPY,
  ROOM_TONE_HOST_COPY,
  ROOM_TONE_NOT_READY_COPY,
  ROOM_TONE_PROMPT_COPY,
  ROOM_TONE_TOO_LOUD_COPY,
  type RoomToneDelivery,
  type RoomToneStatus,
  STOP_CONFIRM_COPY,
  UploadStatus,
} from "../../record";
import { Sheet } from "../../system/Sheet";
import { Button, InlineConfirm } from "../../ui";
import { BUSY_REASON } from "../../ui/disabledReason";

const MIC_REASON = "Allow the microphone before recording room tone.";

export type RecordMoreSheetProps = {
  open: boolean;
  onClose: () => void;
  busy: boolean;
  land: LandGate | null;
  onLand: () => void;
  canStop: boolean;
  onStop: () => void;
  roomTone: {
    available: boolean;
    status: RoomToneStatus;
    delivery: RoomToneDelivery;
    error: string | null;
    micReady: boolean;
    captureReady: boolean;
    onRecord: () => void;
  };
  upload: ComponentProps<typeof UploadStatus>["progress"];
  keeperActions: ComponentProps<typeof UploadStatus>["actions"];
  stopped: boolean;
  onResumeUpload: () => void;
  removedInvite: boolean;
  onInvite: () => void;
};

function roomToneReason(tone: RecordMoreSheetProps["roomTone"]) {
  if (!tone.micReady) return MIC_REASON;
  if (!tone.captureReady) return ROOM_TONE_NOT_READY_COPY;
  if (tone.status === "capturing") return ROOM_TONE_CAPTURING_COPY;
  return undefined;
}

export function RecordMoreSheet({
  open,
  onClose,
  busy,
  land,
  onLand,
  canStop,
  onStop,
  roomTone,
  upload,
  keeperActions,
  stopped,
  onResumeUpload,
  removedInvite,
  onInvite,
}: RecordMoreSheetProps) {
  const [confirming, setConfirming] = useState(false);
  return (
    <Sheet
      form="centered"
      title="More"
      open={open}
      onClose={() => {
        setConfirming(false);
        onClose();
      }}
    >
      <div className="stack">
        {canStop ? (
          confirming ? (
            <InlineConfirm
              prompt={STOP_CONFIRM_COPY}
              keepLabel="Keep recording"
              actionLabel="Stop take"
              disabledReason={busy ? BUSY_REASON : undefined}
              onKeep={() => setConfirming(false)}
              onConfirm={() => {
                setConfirming(false);
                onClose();
                onStop();
              }}
            />
          ) : (
            <Button variant="danger" onClick={() => setConfirming(true)}>
              Stop take
            </Button>
          )
        ) : null}
        {land ? (
          <Button
            disabledReason={land.enabled ? undefined : land.reason}
            aria-disabled={busy || undefined}
            onClick={onLand}
          >
            {land.label}
          </Button>
        ) : null}
        {roomTone.available ? (
          <div className="stack" aria-live="polite">
            <Button
              disabledReason={roomToneReason(roomTone)}
              onClick={roomTone.onRecord}
            >
              {roomTone.status === "capturing"
                ? ROOM_TONE_CAPTURING_COPY
                : ROOM_TONE_PROMPT_COPY}
            </Button>
            {roomTone.status === "too_loud" ? (
              <p className="stage-host-note">{ROOM_TONE_TOO_LOUD_COPY}</p>
            ) : null}
            {roomTone.status === "recorded" ? (
              <p className="stage-host-note">
                {roomTone.delivery === "host"
                  ? ROOM_TONE_HOST_COPY
                  : ROOM_TONE_DEVICE_COPY}
              </p>
            ) : null}
            {roomTone.error ? (
              <p className="stage-host-note">{roomTone.error}</p>
            ) : null}
          </div>
        ) : null}
        <UploadStatus
          progress={upload}
          stopped={stopped}
          segmentList={false}
          onResume={onResumeUpload}
          actions={keeperActions}
        />
        {removedInvite ? (
          <p className="stage-host-note">
            A removed participant’s invite is closed to new participants. Use
            Invite and links to replace that role’s link; existing recording
            access remains available to participants who still hold a valid
            lease.
          </p>
        ) : null}
        <Button onClick={onInvite}>Invite and links…</Button>
      </div>
    </Sheet>
  );
}
