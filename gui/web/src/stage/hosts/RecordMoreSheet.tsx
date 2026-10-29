import { type ComponentProps, useState } from "react";
import { type LandGate, STOP_CONFIRM_COPY, UploadStatus } from "../../record";
import { Sheet } from "../../system/Sheet";
import { Button, InlineConfirm } from "../../ui";
import { BUSY_REASON } from "../../ui/disabledReason";

export type RecordMoreSheetProps = {
  open: boolean;
  onClose: () => void;
  busy: boolean;
  land: LandGate | null;
  onLand: () => void;
  canStop: boolean;
  onStop: () => void;
  upload: ComponentProps<typeof UploadStatus>["progress"];
  keeperActions: ComponentProps<typeof UploadStatus>["actions"];
  stopped: boolean;
  onResumeUpload: () => void;
  removedInvite: boolean;
  onInvite: () => void;
  onDevices: () => void;
};

export function RecordMoreSheet({
  open,
  onClose,
  busy,
  land,
  onLand,
  canStop,
  onStop,
  upload,
  keeperActions,
  stopped,
  onResumeUpload,
  removedInvite,
  onInvite,
  onDevices,
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
        <Button onClick={onDevices}>Devices…</Button>
        <Button onClick={onInvite}>Invite and links…</Button>
      </div>
    </Sheet>
  );
}
