import type { SessionState } from "../types/session";

/**
 * A durable session Applied carries only fields written by the represented
 * command(s). Envelope metadata stays present so authority and cursors do not
 * depend on whether this command changed a transport field.
 */
export type SessionAppliedDelta = Partial<SessionState>;

export function sessionAppliedHasGap(
  heldServerSeq: number | null,
  prevSeq: number | undefined,
  incomingServerSeq: number,
): boolean {
  if (heldServerSeq === null || !Number.isInteger(incomingServerSeq)) {
    return true;
  }
  if (incomingServerSeq <= heldServerSeq) {
    return false;
  }
  return !Number.isInteger(prevSeq) || prevSeq !== heldServerSeq;
}

export function mergeSessionAppliedDelta(
  current: SessionState,
  patch: SessionAppliedDelta,
): SessionState {
  const merged = { ...current, ...patch };
  delete merged.clients;
  delete merged.roster_version;
  return merged;
}

export function withAgentAppliedAuthority(
  snapshot: SessionState,
  hint: SessionAppliedDelta,
  command: { client_id?: string; command_id?: string } = {},
): SessionState {
  return {
    ...snapshot,
    origin: "agent",
    last_role: "agent",
    last_command_id:
      hint.last_command_id ?? command.command_id ?? snapshot.last_command_id,
    last_client_id:
      hint.last_client_id ?? command.client_id ?? snapshot.last_client_id,
  };
}
