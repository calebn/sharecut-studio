import type { VirtualPiece } from "../utils/clipTiming";

export const PIECE_CULL_MIN = 20;

export function visiblePieceRange(opts: {
  pieces: readonly VirtualPiece[];
  leftCss: number;
  zoom: number;
  scrollLeft: number;
  viewportWidth: number;
}): [number, number] {
  const { pieces, leftCss, zoom, scrollLeft, viewportWidth } = opts;
  const viewL = scrollLeft - viewportWidth;
  const viewR = scrollLeft + 2 * viewportWidth;
  let lo = pieces.length;
  let hi = -1;
  pieces.forEach((piece, i) => {
    const l = leftCss + piece.tlA * zoom;
    const r = l + (piece.srcB - piece.srcA) * zoom;
    if (r >= viewL && l <= viewR) {
      lo = Math.min(lo, i);
      hi = i;
    }
  });
  return [lo, hi];
}
