/**
 * Bind a sender over the given socket.
 *
 * Returns `true` when the socket was open and the frame went out, `false`
 * otherwise, so a caller can fall back to an HTTP publish when the socket is
 * down (or not yet open).
 */
/** Sends one frame; `true` when the socket was open and the frame went out. */
export type WsSender = (frame: Record<string, unknown>) => boolean;

export function bindWsSender(ws: WebSocket | null): WsSender {
  return (frame) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame));
      return true;
    }
    return false;
  };
}
