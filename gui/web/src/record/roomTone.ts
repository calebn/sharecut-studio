import type { RoomAlertInput } from "../system/roomAlertModel";
import { quietCountdownText } from "../system/roomPhase";
import { linearToDb } from "../utils/audio";
import {
  ROOM_TONE_DURATION_SEC,
  ROOM_TONE_SAVING_COPY,
  ROOM_TONE_TOO_LOUD_DBFS,
} from "./types";

export type RoomToneStatus =
  | "idle"
  | "capturing"
  | "too_loud"
  | "too_short"
  | "recorded"
  | "skipped"
  | "error";

/** Where a recorded bed has got to; the host registers it at session end. */
export type RoomToneDelivery = "device" | "host";

export function rmsDbfs(samples: Float32Array): number {
  if (samples.length === 0) {
    return Number.NEGATIVE_INFINITY;
  }
  let sum = 0;
  for (const value of samples) {
    sum += value * value;
  }
  return linearToDb(Math.sqrt(sum / samples.length));
}

export function roomToneTooLoud(samples: Float32Array): boolean {
  return rmsDbfs(samples) > ROOM_TONE_TOO_LOUD_DBFS;
}

export function roomToneReady(status: RoomToneStatus): boolean {
  return (
    status === "recorded" ||
    status === "skipped" ||
    status === "too_loud" ||
    status === "too_short"
  );
}

/**
 * What the capturing take shows: whole seconds left, and `saving` once the take
 * is over (ended early or out of time) and the bed is being kept; the clock then stops.
 */
export type RoomToneClock = {
  remainingSec: number;
  progress: number;
  saving: boolean;
};

export function roomToneClock(elapsedSec: number): RoomToneClock {
  const remainingSec = Math.min(
    ROOM_TONE_DURATION_SEC,
    Math.max(0, Math.ceil(ROOM_TONE_DURATION_SEC - elapsedSec)),
  );
  return {
    remainingSec,
    progress: (ROOM_TONE_DURATION_SEC - remainingSec) / ROOM_TONE_DURATION_SEC,
    saving: remainingSec === 0,
  };
}

/** The line a capturing take prints: the quiet countdown, then "Saving room tone…". */
export function roomToneCapturingText(clock: RoomToneClock): string {
  return clock.saving
    ? ROOM_TONE_SAVING_COPY
    : quietCountdownText(clock.remainingSec);
}

const SAVING_REASON = "Room tone is saving.";

/** The alert slot's row while a take runs, for a host-prompted, late or self-started capture. */
export function roomToneCapturingAlert(controls: {
  status: RoomToneStatus;
  clock: RoomToneClock;
  endEarly: () => void;
  cancel: () => void;
}): RoomAlertInput | null {
  if (controls.status !== "capturing") {
    return null;
  }
  return {
    kind: "room-tone-capturing",
    message: roomToneCapturingText(controls.clock),
    progress: controls.clock.progress,
    onAction: controls.endEarly,
    actionDisabledReason: controls.clock.saving ? SAVING_REASON : undefined,
    onSecondaryAction: controls.cancel,
  };
}
