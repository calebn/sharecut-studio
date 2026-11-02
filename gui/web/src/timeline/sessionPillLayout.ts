import type { SessionBand } from "./sessionBands";

export type PillPlacement = { band: SessionBand; left: number; width: number };

const PILL_PAD_PX = 12;
const PILL_CHAR_PX = 7;
const PILL_GAP_PX = 2;

const REM_PX = 16;

/** The pill's width in px, figured from its label (border, padding and the micro font's glyphs at a 16 px root) and scaled by the root font size, since its padding and font are rem. */
export function pillWidthPx(label: string, rootPx: number = REM_PX): number {
  return ((PILL_PAD_PX + PILL_CHAR_PX * label.length) * rootPx) / REM_PX;
}

/**
 * Where each pill sits in the ruler's px, left to right by band start: at its
 * band's left edge, or just right of the previous pill, and pulled left so the
 * pill stays inside `width`. A pill that cannot fit without covering an earlier
 * one is left out (a narrow ruler hides later sessions), so no pill ever covers
 * another and none reaches past the row's clip.
 */
export function layoutPills(
  bands: readonly SessionBand[],
  xOf: (seconds: number) => number,
  width: number,
  rootPx: number = REM_PX,
): PillPlacement[] {
  const placed: PillPlacement[] = [];
  let right = Number.NEGATIVE_INFINITY;
  for (const band of bands) {
    const from = Math.max(0, xOf(band.start));
    const to = Math.min(width, xOf(band.end));
    if (to <= from) continue;
    const pillWidth = pillWidthPx(band.label, rootPx);
    const gap = (PILL_GAP_PX * rootPx) / REM_PX;
    const left = Math.min(Math.max(from, right + gap), width - pillWidth);
    if (left < 0 || left < right + gap) continue;
    placed.push({ band, left, width: pillWidth });
    right = left + pillWidth;
  }
  return placed;
}
