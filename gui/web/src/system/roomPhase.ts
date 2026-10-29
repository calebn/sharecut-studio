import type { StatusState } from "./statusText";

export type RoomPhase =
  | { kind: "waiting"; host?: string }
  | { kind: "countdown"; secondsLeft: 3 | 2 | 1 }
  /** The Stage bar's badge has no take to name; the pill then reads the clock alone. */
  | { kind: "live"; take?: number; clockSec: number }
  | { kind: "paused"; clockSec: number }
  | {
      kind: "saving";
      savedPeople: number;
      totalPeople: number;
      /** 0 to 100, the viewer's own upload; the pill and dock then read it instead of the people count. */
      percent?: number;
      /** The viewer's own upload stopped: the pill reads failed and Leave is not held. */
      failed?: boolean;
    }
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

/** 0 to 100 as a whole number, or null when the phase carries none. */
export function savingPercent(
  phase: Extract<RoomPhase, { kind: "saving" }>,
): number | null {
  if (phase.percent === undefined || !Number.isFinite(phase.percent)) {
    return null;
  }
  return Math.round(Math.min(100, Math.max(0, phase.percent)));
}

/** `compact` is the Stage bar's form: the clock alone while live, the word while paused. */
export function roomPillRendering(
  phase: RoomPhase,
  compact = false,
): Rendering {
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
        text:
          compact || phase.take === undefined
            ? clockText(phase.clockSec)
            : `${clockText(phase.clockSec)} · Take ${phase.take}`,
      };
    case "paused":
      return {
        state: "not-yet",
        text: compact ? "Paused" : `Paused · ${clockText(phase.clockSec)}`,
      };
    case "saving": {
      if (phase.failed) {
        return { state: "failed", text: "Saving stopped" };
      }
      const percent = savingPercent(phase);
      if (percent !== null) {
        return {
          state: "running",
          text: `Saving · ${percent}%`,
          progress: percent / 100,
        };
      }
      return {
        state: "running",
        text: `Saving · ${phase.savedPeople} of ${phase.totalPeople}`,
        progress: phase.totalPeople ? phase.savedPeople / phase.totalPeople : 0,
      };
    }
    case "saved":
      return { state: "done", text: "Saved" };
    case "reconnecting":
      return { state: "offline", text: "Reconnecting…" };
  }
}
