import {
  clipRowDuringRoll,
  type RollPreview,
} from "../../edit/clipEdgePreview";
import {
  drawnOverlapPx,
  isJoin,
  type JoinTier,
  joinLengthMs,
  joinTier,
  joinVisual,
} from "../../edit/joinRender";
import type { ClipRow } from "../../types/project";
import {
  JOIN_KINDS,
  type JoinMarkerKind,
  joinKind,
  joinMarkLabel,
  markerLabel,
} from "../../utils/editMarkerRegistry";
import { clampZoomPxPerSec } from "../../utils/zoom";

export interface JoinMark {
  id: string;
  clipId: string;
  kind: JoinMarkerKind;
  sec: number;
  /** The rows either side of the seam, rolled by a live roll as the clips draw. */
  left: ClipRow;
  right: ClipRow;
}

export const CLUSTER_PX = 24;

/** Half the 12 px glyph, and the gap before its label (canvas px, like CLUSTER_PX). */
const GLYPH_HALF_PX = 6;
const LABEL_GAP_PX = 4;
/** A chip is at most 24 px wide, so 12 px reaches left of its centre. */
const CHIP_HALF_PX = 12;

export type PlacedSymbol = {
  mark: JoinMark;
  xPx: number;
  /** The overlap as drawn (px), the open length draft included. */
  drawnPx: number;
  tier: JoinTier;
  /** The mark's text ("Crossfade 120 ms"), shown beside the glyph when `labelAllowed` and it fits `roomPx`. */
  label: string;
  labelAllowed: boolean;
  /** Px from the glyph's right edge to the next mark or chip, or the end of the session. */
  roomPx: number;
};
export type PlacedChip = {
  marks: readonly JoinMark[];
  xPx: number;
  startSec: number;
  endSec: number;
  /** The zoom that splits the group, or null when zooming in cannot. */
  zoomTo: number | null;
};
export interface LanePlan {
  symbols: readonly PlacedSymbol[];
  chips: readonly PlacedChip[];
}

export function joinPopoverId(clipId: string): string {
  return `join-popover-${clipId}`;
}

export function collectJoinMarks(
  clips: readonly ClipRow[],
  roll: RollPreview | null,
  isMoving: (id: string) => boolean,
): readonly JoinMark[] {
  const marks: JoinMark[] = [];
  for (let i = 1; i < clips.length; i += 1) {
    if (isMoving(clips[i - 1].id) || isMoving(clips[i].id)) {
      continue;
    }
    const left = clipRowDuringRoll(clips[i - 1], roll);
    const right = clipRowDuringRoll(clips[i], roll);
    if (!isJoin(left, right)) {
      continue;
    }
    marks.push({
      id: `join-${right.id}`,
      clipId: right.id,
      kind: joinKind(right),
      sec: right.timeline_start,
      left,
      right,
    });
  }
  return marks;
}

/** The crossfade's own overlap is the only join with a drawn length; the rest are points. */
function placeSymbol(
  mark: JoinMark,
  xPx: number,
  zoomPxPerSec: number,
  draft: ClipRow | null,
): Omit<PlacedSymbol, "roomPx"> {
  const right = draft?.id === mark.right.id ? draft : mark.right;
  const drawnPx = drawnOverlapPx(joinVisual(right, zoomPxPerSec));
  const tier = joinTier(drawnPx);
  const lengthMs =
    mark.kind === "join-crossfade"
      ? (right.join_crossfade_ms ?? 0)
      : joinLengthMs(mark.left, right);
  return {
    mark,
    xPx,
    drawnPx,
    tier,
    label: joinMarkLabel(mark.kind, lengthMs),
    labelAllowed: tier === "wide" || drawnPx === 0,
  };
}

export function planLaneMarks(
  marks: readonly JoinMark[],
  zoomPxPerSec: number,
  sessionSec: number,
  draft: ClipRow | null = null,
): LanePlan {
  const placed = marks
    .map((mark) => ({ mark, xPx: mark.sec * zoomPxPerSec }))
    .sort((a, b) => a.xPx - b.xPx || (a.mark.id < b.mark.id ? -1 : 1));
  const groups: (typeof placed)[] = [];
  for (const item of placed) {
    const open = groups[groups.length - 1];
    if (open && item.xPx - open[open.length - 1].xPx < CLUSTER_PX) {
      open.push(item);
    } else {
      groups.push([item]);
    }
  }
  const symbols: PlacedSymbol[] = [];
  const chips: PlacedChip[] = [];
  const edgePx = (group: typeof placed | undefined): number => {
    if (group == null) {
      return sessionSec * zoomPxPerSec;
    }
    return group.length === 1
      ? group[0].xPx - GLYPH_HALF_PX
      : (group[0].xPx + group[group.length - 1].xPx) / 2 - CHIP_HALF_PX;
  };
  groups.forEach((group, i) => {
    if (group.length === 1) {
      const { mark, xPx } = group[0];
      symbols.push({
        ...placeSymbol(mark, xPx, zoomPxPerSec, draft),
        roomPx: edgePx(groups[i + 1]) - xPx - GLYPH_HALF_PX - LABEL_GAP_PX,
      });
      return;
    }
    const zoom = clusterZoom(
      group.map((item) => item.mark.sec),
      sessionSec,
    );
    chips.push({
      marks: group.map((item) => item.mark),
      xPx: (group[0].xPx + group[group.length - 1].xPx) / 2,
      startSec: group[0].mark.sec,
      endSec: group[group.length - 1].mark.sec,
      zoomTo: zoom > zoomPxPerSec ? zoom : null,
    });
  });
  return { symbols, chips };
}

function clusterZoom(secs: readonly number[], sessionSec: number): number {
  let gapSec = Number.POSITIVE_INFINITY;
  for (let i = 1; i < secs.length; i += 1) {
    gapSec = Math.min(gapSec, secs[i] - secs[i - 1]);
  }
  const zoom =
    gapSec > 0 ? (1.25 * CLUSTER_PX) / gapSec : Number.POSITIVE_INFINITY;
  return clampZoomPxPerSec(zoom, sessionSec);
}

export function chipLabel(chip: PlacedChip): string {
  const parts = JOIN_KINDS.flatMap((kind) => {
    const n = chip.marks.filter((mark) => mark.kind === kind).length;
    if (n === 0) {
      return [];
    }
    return [`${n} ${markerLabel(kind).toLowerCase()}${n > 1 ? "s" : ""}`];
  });
  return `${chip.marks.length} edits: ${parts.join(", ")}${chip.zoomTo == null ? "" : ". Zoom in"}`;
}
