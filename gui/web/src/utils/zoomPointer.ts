/** Last pointer X over the timeline (client coords). Non-reactive — read at zoom time only. */
let zoomPointerClientX: number | null = null;

export function noteZoomPointerClientX(clientX: number | null): void {
  zoomPointerClientX = clientX;
}

export function peekZoomPointerClientX(): number | null {
  return zoomPointerClientX;
}
