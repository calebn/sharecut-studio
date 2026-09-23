import { linearToDb } from "../utils/audio";
import { ROOM_TONE_TOO_LOUD_DBFS } from "./types";

export type RoomToneStatus =
  | "idle"
  | "capturing"
  | "too_loud"
  | "recorded"
  | "skipped"
  | "error";

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
  return status === "recorded" || status === "skipped" || status === "too_loud";
}
