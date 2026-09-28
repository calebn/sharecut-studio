import type { SessionClient } from "../types/session";
import { jsonEqual } from "../utils/jsonEqual";

/**
 * The presence roster keyed by `client_id`. A delta (`applyPresenceDelta`) replaces only
 * its own entry and keeps every other entry's identity, so per-client consumers
 * (`PresenceGhostLayer`'s `GhostRow`, `PresenceOverlayView`'s row) re-render only the
 * client that changed. See `docs/session-sync.md`'s client apply model.
 */
export type SessionRoster = Record<string, SessionClient>;

export const EMPTY_ROSTER: SessionRoster = {};

/**
 * Build a roster keyed by `client_id` from a full client list (a `Presence` / hello
 * `Snapshot` roster). Reuses `prev`'s entry object when it is equal by value
 * (`jsonEqual`), so a full-roster resend that changes nothing keeps every entry's
 * identity too.
 */
export function rosterFromList(
  list: SessionClient[],
  prev: SessionRoster = EMPTY_ROSTER,
): SessionRoster {
  const next: SessionRoster = {};
  for (const client of list) {
    const existing = prev[client.client_id];
    next[client.client_id] =
      existing && jsonEqual(existing, client) ? existing : client;
  }
  return next;
}

const listCache = new WeakMap<SessionRoster, SessionClient[]>();

/**
 * `Object.values(roster)`, memoized per roster object identity: an unchanged roster
 * keeps the same array reference across calls, so store selectors and `useMemo` deps
 * built from it stay stable.
 */
export function sessionClientList(roster: SessionRoster): SessionClient[] {
  const cached = listCache.get(roster);
  if (cached) {
    return cached;
  }
  const list = Object.values(roster);
  listCache.set(roster, list);
  return list;
}

/**
 * One `PresenceDelta` frame's `changes`: `presence_delta.py`'s `row_changes` shape.
 * `meta` holds only the meta keys that changed; a value of `null` means that meta key
 * was removed.
 */
export type PresenceDeltaChanges = Partial<
  Omit<SessionClient, "client_id" | "meta">
> & {
  meta?: Record<string, unknown> | null;
};

/** Meta keys never merged from a peer delta: assigning `__proto__` on a plain object swaps
 * its prototype. The server already allow-lists meta keys (`PresenceMeta`,
 * `extra="ignore"`); this is defense in depth. */
const UNSAFE_META_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function mergeMetaChanges(
  prev: SessionClient["meta"],
  changes: Record<string, unknown>,
): SessionClient["meta"] {
  const merged: Record<string, unknown> = { ...(prev ?? {}) };
  for (const [key, value] of Object.entries(changes)) {
    if (UNSAFE_META_KEYS.has(key)) {
      continue;
    }
    if (value === null) {
      delete merged[key];
    } else {
      merged[key] = value;
    }
  }
  return merged as SessionClient["meta"];
}

/** Merge one client's `PresenceDelta` changes onto its previous roster entry (or a bare
 * stub when the client is not yet known). Never mutates either input. */
export function mergeRosterClient(
  clientId: string,
  prev: SessionClient | undefined,
  changes: PresenceDeltaChanges,
): SessionClient {
  const { meta: metaChanges, ...rowChanges } = changes;
  const base: SessionClient = prev ?? { client_id: clientId, role: "viewer" };
  return {
    ...base,
    ...rowChanges,
    client_id: clientId,
    meta: metaChanges ? mergeMetaChanges(base.meta, metaChanges) : base.meta,
  };
}

export type ApplyPresenceDeltaOutcome = "applied" | "stale" | "resync";

export interface ApplyPresenceDeltaResult {
  roster: SessionRoster;
  version: number;
  outcome: ApplyPresenceDeltaOutcome;
}

/**
 * Apply one `PresenceDelta` to `roster` at `localVersion`. The client rule (#598):
 * equal version -> apply; older version -> drop (`"stale"`); a newer version, or an
 * author client id this roster does not know yet, -> `"resync"` (the caller should send
 * a `RosterRequest`). `roster`/`localVersion` are returned unchanged for `"stale"` and
 * `"resync"`.
 */
export function applyPresenceDelta(
  roster: SessionRoster,
  localVersion: number,
  authorClientId: string,
  changes: PresenceDeltaChanges,
  rosterVersion: number,
): ApplyPresenceDeltaResult {
  if (rosterVersion < localVersion) {
    return { roster, version: localVersion, outcome: "stale" };
  }
  if (rosterVersion > localVersion || !(authorClientId in roster)) {
    return { roster, version: localVersion, outcome: "resync" };
  }
  const nextEntry = mergeRosterClient(
    authorClientId,
    roster[authorClientId],
    changes,
  );
  return {
    roster: { ...roster, [authorClientId]: nextEntry },
    version: rosterVersion,
    outcome: "applied",
  };
}
