import type { OfflineConflict } from "../../services/offlineQueue/offlineStore";
import type { HostCause } from "../../state/hostReach";

/** What a host can say about the last change, derived from the send and queue state. */
export type SaveState =
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "waiting"; count: number; guest?: boolean }
  | { kind: "unreachable"; count: number }
  | { kind: "away"; cause: HostCause; count: number }
  | {
      kind: "unknown";
      reason: string;
      recovery: "retry-same-command" | "inspect-history";
    }
  | { kind: "failed"; cause: "unreadable" }
  | { kind: "failed"; cause: "project-unavailable"; reason: string };

type SaveStateInput = {
  /** A save, send or replay is in flight in this tab. */
  busy: boolean;
  /** Edits in the offline queue, not yet applied. */
  pending: number;
  guest?: boolean;
  /** Outcomes the Needs attention group lists, newest last. */
  conflicts: readonly OfflineConflict[];
  /** A share guest is reading the saved copy because the host cannot be reached. */
  unreachable: boolean;
  away: HostCause | null;
  /** The saved edits on this device could not be read. */
  unreadable: boolean;
  /** A read of the queue has succeeded at least once. */
  loaded: boolean;
  /** A send ended and the queue has not been read since, so the counts are stale. */
  settling: boolean;
};

/**
 * The newest outcome that says something about a save. A refused command wrote
 * nothing and lost no edit, so it stays in Needs attention but never turns the
 * light red.
 */
export function latestSaveOutcome(
  conflicts: readonly OfflineConflict[],
): OfflineConflict | undefined {
  return conflicts.findLast((conflict) => conflict.kind !== "refused");
}

/**
 * A refused command lost no edit, except when the project file itself is missing or
 * damaged: then nothing can be saved, so that refusal turns the light red until it is
 * dismissed or a later command saves.
 *
 * An unreadable queue still reads as failed. Away comes ahead of busy and
 * settling: while the host cannot be reached the poll and the drain timer keep
 * flipping busy, and the light must not churn between Saving and Saved. Busy or
 * settling wins over what is left because an edit on its way, or one whose
 * outcome is not yet read back, is the freshest fact. Then an unknown outcome,
 * and edits waiting; the rest is saved. Null until the queue has been
 * read once, so a project never claims "Saved" before it knows.
 */
export function saveStateOf(input: SaveStateInput): SaveState | null {
  if (input.away && !input.unreadable) {
    return { kind: "away", cause: input.away, count: input.pending };
  }
  if (input.busy || input.settling) return { kind: "saving" };
  if (input.unreadable) return { kind: "failed", cause: "unreadable" };
  if (!input.loaded) return null;
  if (input.unreachable) return { kind: "unreachable", count: input.pending };
  const blocked = input.conflicts.findLast(
    (c) => c.kind === "refused" && c.blocksSave === true && !c.dismissed,
  );
  if (blocked) {
    return {
      kind: "failed",
      cause: "project-unavailable",
      reason: blocked.reason,
    };
  }
  const latestOutcome = latestSaveOutcome(input.conflicts);
  if (latestOutcome?.kind === "unknown") {
    return {
      kind: "unknown",
      reason: latestOutcome.reason,
      recovery: latestOutcome.recovery,
    };
  }
  if (input.pending > 0) {
    return {
      kind: "waiting",
      count: input.pending,
      ...(input.guest ? { guest: true } : {}),
    };
  }
  return { kind: "saved" };
}
