import type { RecordSnapshot } from "./types";

export function startBlockers(
  snap: RecordSnapshot | null | undefined,
): string[] {
  if (!snap) {
    return ["No one has joined"];
  }
  return snap.start_blockers ?? ["No one has joined"];
}
