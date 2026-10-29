import type { DeviceMic, DeviceTone } from "../system/deviceSheetModel";
import { joinMic } from "./guestRoomModel";
import type { MicPermissionStatus } from "./micPermission";
import type { RoomToneDelivery, RoomToneStatus } from "./roomTone";
import {
  ROOM_TONE_CAPTURING_COPY,
  ROOM_TONE_DEVICE_COPY,
  ROOM_TONE_HOST_COPY,
  ROOM_TONE_NOT_READY_COPY,
  ROOM_TONE_PROMPT_COPY,
  ROOM_TONE_TOO_LOUD_COPY,
} from "./types";

const MIC_REASON = "Allow the microphone before recording room tone.";
const TAKE_REASON = "Record room tone between takes.";

/** The Join sheet's mic, with a missing input told apart from a lost one. */
export function deviceMic(
  mic: Parameters<typeof joinMic>[0],
  options: Parameters<typeof joinMic>[1],
): DeviceMic {
  return mic.status === "unavailable"
    ? { status: "none" }
    : joinMic(mic, options);
}

/** The status a host's capture reports, with a lost stream read as lost. */
export function hostMicStatus(
  status: MicPermissionStatus | null,
  lost: boolean,
): MicPermissionStatus {
  return lost ? "lost" : (status ?? "idle");
}

/** The room tone row: why the button waits, and what the last try did. */
export function deviceTone(args: {
  status: RoomToneStatus;
  delivery: RoomToneDelivery;
  error: string | null;
  micReady: boolean;
  captureReady: boolean;
  takeRunning: boolean;
}): DeviceTone {
  const { status } = args;
  const capturing = status === "capturing";
  const disabledReason = !args.micReady
    ? MIC_REASON
    : args.takeRunning
      ? TAKE_REASON
      : !args.captureReady
        ? ROOM_TONE_NOT_READY_COPY
        : capturing
          ? ROOM_TONE_CAPTURING_COPY
          : undefined;
  const label = capturing ? ROOM_TONE_CAPTURING_COPY : ROOM_TONE_PROMPT_COPY;
  if (status === "too_loud") {
    return {
      state: "too-loud",
      label,
      message: ROOM_TONE_TOO_LOUD_COPY,
      disabledReason,
    };
  }
  if (status === "recorded") {
    return {
      state: "recorded",
      label,
      message:
        args.delivery === "host" ? ROOM_TONE_HOST_COPY : ROOM_TONE_DEVICE_COPY,
      disabledReason,
    };
  }
  if (status === "error") {
    return {
      state: "error",
      label,
      message: args.error ?? undefined,
      disabledReason,
    };
  }
  return {
    state: capturing ? "capturing" : "idle",
    label,
    disabledReason,
  };
}
