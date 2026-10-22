import { type ReactNode, useId } from "react";
import { Button, Field } from "../ui";
import { ConsentGate } from "./ConsentGate";
import { DeviceCheck } from "./DeviceCheck";
import type { MicPermissionStatus } from "./micPermission";
import { RoomToneCapture } from "./RoomToneCapture";
import type { RoomToneDelivery, RoomToneStatus } from "./roomTone";
import { StorageHeadroomWarning } from "./StorageHeadroomWarning";
import { LOCAL_KEEPER_PENDING_COPY, ROOM_TONE_GATE_COPY } from "./types";

type Props = {
  producer: boolean;
  name: string;
  onName: (name: string) => void;
  headphonesOk: boolean;
  onHeadphones: (ok: boolean) => void;
  deviceId: string;
  onDeviceId: (id: string) => void;
  onJoinProducer: () => void;
  onAccept: () => void;
  onDecline: () => void;
  showMic: boolean;
  stream: MediaStream | null;
  devices: MediaDeviceInfo[];
  micError: string | null;
  settingsWarning: string | null;
  micNotice?: string | null;
  deviceLocked?: boolean;
  permission: MicPermissionStatus;
  onAllowMic: () => void;
  onRetryMic: () => void;
  roomToneStatus?: RoomToneStatus;
  roomToneDelivery?: RoomToneDelivery;
  roomToneError?: string | null;
  onRecordRoomTone?: () => void;
  onSkipRoomTone?: () => void;
  onRetryRoomTone?: () => void;
  roomToneReady?: boolean;
  roomToneCaptureReady?: boolean;
  localStorageReady?: boolean;
  localStorageError?: string | null;
  onRetryStorage?: () => void;
  showRoomTone?: boolean;
  /** Fixture notice for standalone previews; omit for the live storage check. */
  storageHeadroomNotice?: ReactNode;
};

export function Lobby({
  producer,
  name,
  onName,
  headphonesOk,
  onHeadphones,
  deviceId,
  onDeviceId,
  onJoinProducer,
  onAccept,
  onDecline,
  showMic,
  stream,
  devices,
  micError,
  settingsWarning,
  micNotice,
  deviceLocked = false,
  permission,
  onAllowMic,
  onRetryMic,
  roomToneStatus = "idle",
  roomToneDelivery = "device",
  roomToneError = null,
  onRecordRoomTone = () => undefined,
  onSkipRoomTone = () => undefined,
  onRetryRoomTone = () => undefined,
  roomToneReady = true,
  roomToneCaptureReady = true,
  localStorageReady = true,
  localStorageError = null,
  onRetryStorage,
  showRoomTone = true,
  storageHeadroomNotice,
}: Props) {
  const phonesId = useId();
  const grantHintId = useId();
  const headphonesHintId = useId();
  const roomToneGateId = useId();
  const localStorageGateId = useId();
  const micReady = permission === "granted";
  const localStorageCopy =
    localStorageError ??
    (!localStorageReady ? LOCAL_KEEPER_PENDING_COPY : null);
  const acceptDisabledReason = !micReady
    ? "Allow the microphone to accept."
    : !headphonesOk
      ? "Confirm you are wearing headphones to accept."
      : !localStorageReady
        ? (localStorageCopy ?? LOCAL_KEEPER_PENDING_COPY)
        : !roomToneReady
          ? ROOM_TONE_GATE_COPY
          : undefined;
  const acceptDescribedBy = [
    !micReady ? grantHintId : null,
    !headphonesOk ? headphonesHintId : null,
    !roomToneReady && localStorageReady ? roomToneGateId : null,
    !localStorageReady ? localStorageGateId : null,
  ]
    .filter((id): id is string => id != null)
    .join(" ");
  return (
    <div className="stack">
      <Field label="Display name">
        {(control) => (
          <input
            {...control}
            value={name}
            onChange={(e) => onName(e.target.value)}
            autoComplete="name"
          />
        )}
      </Field>
      {producer ? (
        <Button variant="primary" type="button" onClick={onJoinProducer}>
          Join
        </Button>
      ) : (
        <>
          {storageHeadroomNotice === undefined ? (
            <StorageHeadroomWarning />
          ) : (
            storageHeadroomNotice
          )}
          <label className="cluster" htmlFor={phonesId}>
            <input
              id={phonesId}
              type="checkbox"
              checked={headphonesOk}
              onChange={(e) => onHeadphones(e.target.checked)}
            />
            I am wearing headphones
          </label>
          {showMic ? (
            <>
              <DeviceCheck
                headphonesOk={headphonesOk}
                deviceId={deviceId}
                onDeviceId={onDeviceId}
                stream={stream}
                devices={devices}
                error={micError}
                settingsWarning={settingsWarning}
                notice={micNotice}
                deviceLocked={deviceLocked}
                permission={permission}
                onAllow={onAllowMic}
                onRetry={onRetryMic}
                grantHintId={grantHintId}
                headphonesHintId={headphonesHintId}
              />
              {showRoomTone ? (
                <>
                  <RoomToneCapture
                    status={roomToneStatus}
                    delivery={roomToneDelivery}
                    error={roomToneError}
                    micReady={micReady}
                    captureReady={roomToneCaptureReady}
                    onRecord={onRecordRoomTone}
                    onSkip={onSkipRoomTone}
                    onRetry={onRetryRoomTone}
                  />
                  {!roomToneReady && localStorageReady ? (
                    <p id={roomToneGateId}>{ROOM_TONE_GATE_COPY}</p>
                  ) : null}
                </>
              ) : null}
              {localStorageCopy ? (
                <div>
                  <p id={localStorageGateId}>{localStorageCopy}</p>
                  {localStorageError && onRetryStorage ? (
                    <Button type="button" onClick={onRetryStorage}>
                      Retry storage check
                    </Button>
                  ) : null}
                </div>
              ) : null}
              <ConsentGate
                onAccept={onAccept}
                onDecline={onDecline}
                acceptDisabledReason={acceptDisabledReason}
                acceptDescribedBy={
                  acceptDisabledReason && acceptDescribedBy
                    ? acceptDescribedBy
                    : undefined
                }
              />
            </>
          ) : (
            <p>Connecting to the room…</p>
          )}
        </>
      )}
    </div>
  );
}
