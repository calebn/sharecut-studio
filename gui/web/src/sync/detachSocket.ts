/**
 * Detaches every handler from a realtime socket, then closes it, so a late
 * open, message, close or error from it cannot touch the next effect run's
 * state. Shared by the sync hooks' effect cleanups (`useSessionSync`,
 * `useDocumentSync`, `useGuestSync`).
 */
export function detachSocket(ws: WebSocket): void {
  ws.onopen = null;
  ws.onmessage = null;
  ws.onclose = null;
  ws.onerror = null;
  ws.close();
}
