type FollowGeometry = Readonly<{
  playheadSec: number;
  zoomPxPerSec: number;
  viewportPx: number;
  canvasWidthPx: number;
  scrollPx: number;
}>;

export function followPageTarget(_geometry: FollowGeometry): number | null {
  return null;
}

export function isPlayheadOffscreen(
  _geometry: Omit<FollowGeometry, "canvasWidthPx">,
): boolean {
  return false;
}

export function revealTargetPx(
  _geometry: Omit<FollowGeometry, "scrollPx">,
): number {
  return 0;
}
