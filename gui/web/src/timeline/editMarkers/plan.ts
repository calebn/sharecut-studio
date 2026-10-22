import {
  clipRowDuringRoll,
  type RollPreview,
} from "../../edit/clipEdgePreview";
import { isJoin } from "../../edit/joinRender";
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
  /** The rows either side of the seam, rolled by a live roll as the clips draw. */
  left: ClipRow;
  right: ClipRow;
}

export const CLUSTER_PX = 24;

export type PlacedSymbol = { mark: JoinMark; xPx: number };
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

export function planLaneMarks(
  marks: readonly JoinMark[],
  zoomPxPerSec: number,
  sessionSec: number,
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
  for (const group of groups) {
    if (group.length === 1) {
      symbols.push(group[0]);
      continue;
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
  }
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
