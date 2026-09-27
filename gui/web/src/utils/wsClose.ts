/**
 * Server close code for a WS grant revoked after accept (document authz recheck,
 * record-room removal). A pre-accept refusal reaches the browser as 1006 instead.
 */
export const WS_CLOSE_FORBIDDEN = 4403;

/** True when a WS close must not auto-reconnect (the grant is gone until reload). */
export function isTerminalWsClose(code: number): boolean {
  return code === WS_CLOSE_FORBIDDEN;
}
