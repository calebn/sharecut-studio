import type { SessionState } from "../types/session";

export interface AppliedCursor {
  serverSeq: number;
  commandId: string | null;
}

/**
 * Viewer→viewer discrete UI sync (selection/mode/mute). Transport play/pause is
 * local-authoritative; only agents may remotely drive is_playing (Figma-style:
 * presence vs authority).
 */
export const DISCRETE_VIEWER_COMMANDS = new Set([
  "SetMode",
  "SetMuteSolo",
  "SetSelection",
  "ClearRegion",
]);

export function sessionRole(state: SessionState): string | null | undefined {
  return state.last_role ?? state.origin;
}

export function sessionSeq(state: SessionState): number {
  return state.server_seq ?? 0;
}

export function sessionClientId(state: SessionState): string | null {
  const id = (state as { last_client_id?: string | null }).last_client_id;
  return id ?? null;
}

/**
 * First WebSocket Snapshot: apply agent transport before marking command_id
 * applied (otherwise dedupe would no-op the in-flight agent play).
 */
export function baselineFromSnapshot(
  snap: SessionState,
  cursor: AppliedCursor,
): { apply: boolean; next: AppliedCursor } {
  if (cursor.serverSeq !== 0) {
    return { apply: false, next: cursor };
  }
  const seq = sessionSeq(snap);
  const role = sessionRole(snap);
  return {
    apply: role === "agent",
    next: { serverSeq: seq, commandId: snap.last_command_id },
  };
}

function advance(cursor: AppliedCursor, state: SessionState): AppliedCursor {
  return {
    serverSeq: Math.max(sessionSeq(state), cursor.serverSeq),
    commandId: state.last_command_id ?? cursor.commandId,
  };
}

/**
 * Whether an Applied / polled snapshot should update the local DAW.
 *
 * Authority model (Figma-like):
 * - Agent commands apply (remote transport control).
 * - Own client echoes never apply (ack cursor only).
 * - Other viewers: selection/mode/mute may apply; SetPlaying / SetPlayhead do not.
 * - Playhead heartbeats never re-seek local audio.
 */
export function shouldApplyRemote(
  state: SessionState,
  cursor: AppliedCursor,
  opts: {
    commandType?: string | null;
    localPlaying?: boolean;
    localClientId?: string | null;
    commandClientId?: string | null;
  } = {},
): { apply: boolean; next: AppliedCursor } {
  const seq = sessionSeq(state);
  const cmd = state.last_command_id;
  if (cmd && cmd === cursor.commandId) {
    return { apply: false, next: cursor };
  }
  if (seq && seq <= cursor.serverSeq && !cmd) {
    return { apply: false, next: cursor };
  }

  const author = opts.commandClientId ?? sessionClientId(state) ?? null;
  if (opts.localClientId && author && author === opts.localClientId) {
    return { apply: false, next: advance(cursor, state) };
  }

  const role = sessionRole(state);
  if (role === "agent") {
    return { apply: true, next: advance(cursor, state) };
  }

  const ctype = opts.commandType;
  if (
    ctype === "SetPlayhead" ||
    ctype === "SetPlaying" ||
    ctype === "SetRegion" ||
    ctype === "PresenceHeartbeat" ||
    ctype === "Ack" ||
    ctype === "AuditionInViewer" ||
    ctype === "PlayOsAudio"
  ) {
    // Viewer transport is local; agent-only types above already returned.
    return { apply: false, next: advance(cursor, state) };
  }
  if (ctype && DISCRETE_VIEWER_COMMANDS.has(ctype)) {
    return { apply: true, next: advance(cursor, state) };
  }

  // Polled snapshots: never stomp local transport while playing.
  if (opts.localPlaying) {
    return { apply: false, next: advance(cursor, state) };
  }

  if (seq > cursor.serverSeq) {
    // Paused: allow non-transport field refresh, but not is_playing flips from
    // anonymous polls — applyAgentSession must treat viewer polls carefully.
    return { apply: true, next: advance(cursor, state) };
  }
  return { apply: false, next: cursor };
}

/** Filter for WS Applied/Echo messages after the first Snapshot baseline. */
export function shouldHandleWsMessage(
  msg: {
    type: string;
    command?: { role?: string; type?: string; client_id?: string };
    snapshot: SessionState;
  },
  cursor: AppliedCursor,
  opts: { localPlaying?: boolean; localClientId?: string | null } = {},
): boolean {
  const snap = msg.snapshot;
  const author = msg.command?.client_id ?? sessionClientId(snap);
  if (opts.localClientId && author && author === opts.localClientId) {
    return false;
  }
  const role = msg.command?.role ?? sessionRole(snap);
  if (role === "agent" || snap.origin === "agent") {
    return true;
  }
  const ctype = msg.command?.type;
  if (
    ctype === "SetPlayhead" ||
    ctype === "SetPlaying" ||
    ctype === "SetRegion" ||
    ctype === "PresenceHeartbeat" ||
    ctype === "Ack"
  ) {
    return false;
  }
  if (ctype && DISCRETE_VIEWER_COMMANDS.has(ctype)) {
    return (snap.server_seq ?? 0) > cursor.serverSeq;
  }
  if (opts.localPlaying) {
    return false;
  }
  return (snap.server_seq ?? 0) > cursor.serverSeq;
}
