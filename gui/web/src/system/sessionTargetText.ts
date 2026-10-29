import { clockText } from "./roomPhase";

/** Where a session lands, in the terms the chip shows. Times are timeline seconds. */
export type SessionTargetView =
  | { kind: "end"; afterSec?: number }
  | { kind: "start" }
  | { kind: "insert"; atSec: number }
  | { kind: "replace"; fromSec: number; toSec: number };

/** The chip's text for a target; the one wording shared by the trigger and the lock. */
export function sessionTargetText(target: SessionTargetView): string {
  switch (target.kind) {
    case "end":
      return target.afterSec === undefined
        ? "Lands at the end"
        : `Lands at the end · after ${clockText(target.afterSec)}`;
    case "start":
      return "Starts the episode";
    case "insert":
      return `Inserts at ${clockText(target.atSec)}`;
    case "replace":
      return `Replaces ${clockText(target.fromSec)}-${clockText(target.toSec)}`;
  }
}

/** The menu entry that picks `kind`; the playhead entry names the time it would use. */
export function sessionTargetMenuText(
  kind: SessionTargetView["kind"],
  playheadSec?: number,
): string {
  switch (kind) {
    case "end":
      return "At the end";
    case "start":
      return "At the start";
    case "insert":
      return playheadSec === undefined
        ? "At the playhead"
        : `At the playhead (${clockText(playheadSec)})`;
    case "replace":
      return "Replace selection";
  }
}
