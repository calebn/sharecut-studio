import type { StatusState } from "./statusText";

export type RoomPhase =
  | { kind: "waiting"; host?: string }
  | { kind: "countdown"; secondsLeft: 3 | 2 | 1 }
  | { kind: "live"; take: number; clockSec: number }
  | { kind: "paused"; clockSec: number }
  | { kind: "saving"; savedPeople: number; totalPeople: number }
  | { kind: "saved" }
  | { kind: "reconnecting" };

export type Rendering = { state: StatusState; text: string; progress?: number };

/** 754 s is "12:34", an hour or more "1:02:03". */
export function clockText(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = String(sec % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

export function roomPillRendering(phase: RoomPhase): Rendering {
  switch (phase.kind) {
    case "waiting":
      return {
        state: "not-yet",
        text: phase.host ? `Waiting for ${phase.host} to start` : "Waiting",
      };
    case "countdown":
      return {
        state: "running",
        text: `Quiet please · ${phase.secondsLeft}`,
      };
    case "live":
      return {
        state: "live",
        text: `${clockText(phase.clockSec)} · Take ${phase.take}`,
      };
    case "paused":
      return {
        state: "not-yet",
        text: `Paused · ${clockText(phase.clockSec)}`,
      };
    case "saving":
      return {
        state: "running",
        text: `Saving · ${phase.savedPeople} of ${phase.totalPeople}`,
        progress: phase.totalPeople ? phase.savedPeople / phase.totalPeople : 0,
      };
    case "saved":
      return { state: "done", text: "Saved" };
    case "reconnecting":
      return { state: "offline", text: "Reconnecting…" };
  }
}
