import type { DeviceMic, DeviceTone } from "../system/deviceSheetModel";
import { joinMic } from "./guestRoomModel";
import type { MicPermissionStatus } from "./micPermission";
import {
  type RoomToneClock,
  type RoomToneDelivery,
  type RoomToneStatus,
  roomToneCapturingText,
} from "./roomTone";
import {
  ROOM_TONE_DEVICE_COPY,
  ROOM_TONE_HOST_COPY,
  ROOM_TONE_NOT_READY_COPY,
  ROOM_TONE_PROMPT_COPY,
  ROOM_TONE_TOO_LOUD_COPY,
  ROOM_TONE_TOO_SHORT_COPY,
} from "./types";
import { useInputSwitching } from "./useInputSwitching";

const MIC_REASON = "Allow the microphone before recording room tone.";
const TAKE_REASON = "Record room tone between takes.";

type JoinMicInput = Parameters<typeof joinMic>[0];
type JoinMicOptions = Parameters<typeof joinMic>[1];

/**
 * What the Join and Device sheets read the mic from: the input in use (a stale
 * saved id counts as Default) and whether a pick is still opening.
 */
export function useSheetMic(
  mic: JoinMicInput,
  pick: Omit<JoinMicOptions, "deviceId" | "switching"> & {
    deviceId: string;
    stale: boolean;
  },
): { input: JoinMicInput; options: JoinMicOptions } {
  const { stale, ...rest } = pick;
  const deviceId = stale ? "" : pick.deviceId;
  const switching = useInputSwitching(mic.stream, mic.status, deviceId);
  return { input: mic, options: { ...rest, deviceId, switching } };
}

/** The Join sheet's mic, with a missing input told apart from a lost one. */
export function deviceMic(
  mic: JoinMicInput,
  options: JoinMicOptions,
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
  /** The running take's time left; only read while capturing. */
  clock: RoomToneClock;
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
        : undefined;
  const label = ROOM_TONE_PROMPT_COPY;
  if (status === "too_loud") {
    return {
      state: "too-loud",
      label,
      message: ROOM_TONE_TOO_LOUD_COPY,
      disabledReason,
    };
  }
  if (status === "too_short") {
    return {
      state: "too-short",
      label,
      message: ROOM_TONE_TOO_SHORT_COPY,
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
  if (capturing) {
    return {
      state: "capturing",
      label,
      message: roomToneCapturingText(args.clock),
      progress: args.clock.progress,
      endEarlyDisabled: args.clock.saving,
    };
  }
  return { state: "idle", label, disabledReason };
}
