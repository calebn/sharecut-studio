export function bindWsSender(
  ws: WebSocket | null,
): (frame: Record<string, unknown>) => void {
  return (frame) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(frame));
    }
  };
}
