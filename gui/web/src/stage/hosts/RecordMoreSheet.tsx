import { type ComponentProps, useId, useState } from "react";
import { type LandGate, STOP_CONFIRM_COPY, UploadStatus } from "../../record";
import { Sheet } from "../../system/Sheet";
import { Button, InlineConfirm, ToggleButton } from "../../ui";
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
  guestsSeeNotes: boolean;
  onGuestsSeeNotesChange: (enabled: boolean) => void;
  guestsSeeNotesError?: string | null;
  onDevices: () => void;
  /** The host's own mic is part of the session. */
  micOn: boolean;
  onMicChange: (on: boolean) => void;
  /** Why the mic switch cannot change now, such as a running take. */
  micReason?: string;
  /** Absent once the end is pending or being sent. */
  onEndSession?: () => void;
  /** Why End session cannot start yet. */
  endReason?: string;
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
  guestsSeeNotes,
  onGuestsSeeNotesChange,
  guestsSeeNotesError,
  onDevices,
  micOn,
  onMicChange,
  micReason,
  onEndSession,
  endReason,
}: RecordMoreSheetProps) {
  const [confirming, setConfirming] = useState(false);
  const helpId = useId();
  const micHelpId = useId();
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
        <ToggleButton
          pressed={guestsSeeNotes}
          aria-describedby={busy ? undefined : helpId}
          aria-disabled={busy || undefined}
          title={busy ? BUSY_REASON : undefined}
          onClick={() => {
            if (!busy) {
              onGuestsSeeNotesChange(!guestsSeeNotes);
            }
          }}
        >
          Guests see notes
        </ToggleButton>
        <p id={helpId} className="stage-host-note">
          Off: guests see their own notes and everyone’s markers. On: they also
          see other people’s notes.
        </p>
        <div role="status">
          {guestsSeeNotesError ? (
            <p className="inline-error pipeline-error">{guestsSeeNotesError}</p>
          ) : null}
        </div>
        <ToggleButton
          pressed={micOn}
          aria-describedby={micHelpId}
          aria-disabled={busy || micReason !== undefined || undefined}
          title={micReason ?? (busy ? BUSY_REASON : undefined)}
          onClick={() => {
            if (!busy && micReason === undefined) {
              onMicChange(!micOn);
            }
          }}
        >
          Record my mic
        </ToggleButton>
        <p id={micHelpId} className="stage-host-note">
          {micReason ??
            (micOn
              ? "On: your mic is recorded with everyone else."
              : "Off: you run the session without recording your own mic. Start needs a guest to have accepted.")}
        </p>
        <Button onClick={onDevices}>Devices…</Button>
        <Button onClick={onInvite}>Invite and links…</Button>
        {onEndSession ? (
          <Button
            variant="danger"
            disabledReason={endReason}
            onClick={() => {
              onClose();
              onEndSession();
            }}
          >
            End session
          </Button>
        ) : null}
      </div>
    </Sheet>
  );
}
