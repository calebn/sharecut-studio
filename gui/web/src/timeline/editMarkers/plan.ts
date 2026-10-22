import {
  clipRowDuringRoll,
  type RollPreview,
} from "../../edit/clipEdgePreview";
import { isJoin, joinVisual } from "../../edit/joinRender";
import type { ClipRow } from "../../types/project";
import {
  JOIN_KINDS,
  type JoinMarkerKind,
  joinKind,
  markerLabel,
} from "../../utils/editMarkerRegistry";
import { clampZoomPxPerSec } from "../../utils/zoom";

export interface JoinMark {
  id: string;
  clipId: string;
  kind: JoinMarkerKind;
  sec: number;
  crossfadeMs: ClipRow["join_crossfade_ms"];
  blocked?: NonNullable<ClipRow["join_crossfade_blocked"]>;
}

export type Tier = "narrow" | "middle" | "wide";

export const TIER_MIDDLE_PX = 8;
export const TIER_WIDE_PX = 24;
export const SHORT_LANE_PX = 40;
export const CLUSTER_PX = 24;

export type Box = { leftPx: number; widthPx: number };
export type PlacedSymbol = {
  mark: JoinMark;
  tier: Tier;
  xPx: number;
  box: Box | null;
};
export type PlacedChip = {
  marks: readonly JoinMark[];
  xPx: number;
  startSec: number;
  endSec: number;
};
export interface LanePlan {
  symbols: readonly PlacedSymbol[];
  chips: readonly PlacedChip[];
}

export function joinPopoverId(clipId: string): string {
  return `join-popover-${clipId}`;
}

export function markerTier(widthPx: number, laneHeightPx: number): Tier {
  if (!(widthPx >= TIER_MIDDLE_PX)) {
    return "narrow";
  }
  if (widthPx < TIER_WIDE_PX || laneHeightPx < SHORT_LANE_PX) {
    return "middle";
  }
  return "wide";
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
      crossfadeMs: right.join_crossfade_ms,
      ...(right.join_crossfade_blocked
        ? { blocked: right.join_crossfade_blocked }
        : {}),
    });
  }
  return marks;
}

function boxOf(mark: JoinMark, zoomPxPerSec: number): Box | null {
  if (mark.kind !== "join-crossfade") {
    return null;
  }
  const visual = joinVisual(
    {
      join_in_mode: "crossfade",
      join_crossfade_blocked: mark.blocked ?? null,
      join_crossfade_ms: mark.crossfadeMs,
      timeline_start: mark.sec,
    },
    zoomPxPerSec,
  );
  return visual.kind === "blend"
    ? { leftPx: visual.leftPx, widthPx: visual.widthPx }
    : null;
}

export function planLaneMarks(
  marks: readonly JoinMark[],
  zoomPxPerSec: number,
  laneHeightPx: number,
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
  groups.forEach((group, g) => {
    if (group.length > 1) {
      chips.push({
        marks: group.map((item) => item.mark),
        xPx: (group[0].xPx + group[group.length - 1].xPx) / 2,
        startSec: group[0].mark.sec,
        endSec: group[group.length - 1].mark.sec,
      });
      return;
    }
    const { mark, xPx } = group[0];
    const box = boxOf(mark, zoomPxPerSec);
    const before =
      g > 0 ? xPx - groups[g - 1][groups[g - 1].length - 1].xPx : Infinity;
    const after = g + 1 < groups.length ? groups[g + 1][0].xPx - xPx : Infinity;
    symbols.push({
      mark,
      xPx,
      box,
      tier: markerTier(
        box ? box.widthPx : Math.min(before, after),
        laneHeightPx,
      ),
    });
  });
  return { symbols, chips };
}

export function clusterZoom(chip: PlacedChip, sessionSec: number): number {
  let gapSec = Number.POSITIVE_INFINITY;
  for (let i = 1; i < chip.marks.length; i += 1) {
    gapSec = Math.min(gapSec, chip.marks[i].sec - chip.marks[i - 1].sec);
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
  return `${chip.marks.length} edits: ${parts.join(", ")}. Zoom in`;
}
