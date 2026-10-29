import type { PendingKind } from "../types/project";

/** The server kinds that make a pending edit a tighten hit: everything but `other`. */
export type TightenClass = Exclude<PendingKind, "other">;

const TIGHTEN_CLASS_SET: Record<TightenClass, true> = {
  filler: true,
  pause: true,
  repeat: true,
  "false-start": true,
  sound: true,
};

/** True for a kind this client knows; an absent or newer kind from an older or newer host is not. */
export function isTightenClass(kind: unknown): kind is TightenClass {
  return typeof kind === "string" && Object.hasOwn(TIGHTEN_CLASS_SET, kind);
}
