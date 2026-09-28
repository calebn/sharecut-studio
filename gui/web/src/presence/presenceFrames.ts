import { useDawStore } from "../state/dawStore";
import type { SessionState } from "../types/session";

/** The presence-plane shape of an inbound session/guest WS frame: a full roster
 * `Presence`, a per-client `PresenceDelta`, or a `Snapshot`/`Applied`/`Echo` that may
 * embed `snapshot.clients` (the hello `Snapshot` only - a durable session `Applied` /
 * `Echo` no longer carries the roster, see `docs/session-sync.md`). */
export type PresenceCarryingFrame = {
  type?: string;
  clients?: SessionState["clients"];
  roster_version?: number;
  author_client_id?: string;
  changes?: Record<string, unknown>;
  snapshot?: SessionState & { participants?: unknown };
};

/**
 * Apply one presence-plane frame to the roster store. Shared by the host
 * (`useSessionSync`) and guest (`useGuestSync`) sockets so both apply the same
 * version/roster rules (`presence/roster.ts`'s `applyPresenceDelta`).
 *
 * Returns `true` when a `PresenceDelta` landed on a stale or unknown-client version and
 * the caller should send a `RosterRequest` (`session/rosterRequest.ts`).
 */
export function applyPresenceFrame(msg: PresenceCarryingFrame): boolean {
  if (msg.type === "Presence" && Array.isArray(msg.clients)) {
    useDawStore.getState().setSessionClients(msg.clients, msg.roster_version);
    return false;
  }
  if (msg.type === "PresenceDelta") {
    if (typeof msg.author_client_id !== "string" || !msg.changes) {
      return false;
    }
    return useDawStore
      .getState()
      .applyPresenceDelta(
        msg.author_client_id,
        msg.changes,
        msg.roster_version ?? 0,
      );
  }
  if (
    (msg.type === "Snapshot" ||
      msg.type === "Applied" ||
      msg.type === "Echo") &&
    msg.snapshot &&
    Array.isArray(msg.snapshot.clients)
  ) {
    useDawStore
      .getState()
      .setSessionClients(msg.snapshot.clients, msg.snapshot.roster_version);
  }
  return false;
}

/** True for the frame types `applyPresenceFrame` fully handles on its own
 * (`Presence` / `PresenceDelta`): the caller has nothing left to do for these. */
export function isPresenceOnlyFrame(msg: PresenceCarryingFrame): boolean {
  return msg.type === "Presence" || msg.type === "PresenceDelta";
}

/** True for a frame that resolves an outstanding `RosterRequest`: it carries a full
 * roster (a `Presence`, or the hello `Snapshot` - never a document-plane `Snapshot`,
 * which has no `clients`). */
export function carriesFullRoster(msg: PresenceCarryingFrame): boolean {
  if (msg.type === "Presence") {
    return Array.isArray(msg.clients);
  }
  if (msg.type === "Snapshot") {
    return Array.isArray(msg.snapshot?.clients);
  }
  return false;
}
