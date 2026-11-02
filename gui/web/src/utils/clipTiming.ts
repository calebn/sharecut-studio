import type { ClipRow } from "../types/project";

export type TimedPlacement = Pick<
  ClipRow,
  "source_start" | "source_end" | "timeline_start" | "timing"
>;

export interface VirtualPiece {
  srcA: number;
  srcB: number;
  tlA: number;
}

export function clipTimingSteps(clip: Pick<ClipRow, "timing">) {
  return clip.timing?.steps ?? [];
}

export function clipVirtualPieces(clip: TimedPlacement): VirtualPiece[] {
  const out: VirtualPiece[] = [];
  let cur = clip.source_start;
  let tl = clip.timeline_start;
  for (const step of clipTimingSteps(clip)) {
    const pieceEndTl = tl + (step.at - cur);
    if (step.at > cur) {
      out.push({ srcA: cur, srcB: step.at, tlA: tl });
    }
    if (step.delta_sec > 0) {
      cur = step.at;
      tl = pieceEndTl + step.delta_sec;
    } else {
      cur = step.at - step.delta_sec;
      tl = pieceEndTl;
    }
  }
  if (clip.source_end > cur) {
    out.push({ srcA: cur, srcB: clip.source_end, tlA: tl });
  }
  return out;
}

export function clipTotalDelta(clip: Pick<ClipRow, "timing">): number {
  let total = 0;
  for (const step of clipTimingSteps(clip)) {
    total += step.delta_sec;
  }
  return total;
}

export function clipTimingDelta(
  clip: Pick<
    ClipRow,
    | "timing"
    | "timing_steps"
    | "source_start"
    | "source_end"
    | "timeline_start"
    | "timeline_end"
  >,
): number {
  if (clip.timing) {
    return clipTotalDelta(clip);
  }
  if ((clip.timing_steps ?? 0) > 0) {
    return (
      clip.timeline_end -
      clip.timeline_start -
      (clip.source_end - clip.source_start)
    );
  }
  return 0;
}

export function clipTimelineEnd(clip: TimedPlacement): number {
  return (
    clip.timeline_start +
    (clip.source_end - clip.source_start) +
    clipTotalDelta(clip)
  );
}

export function pieceTimelineEnd(piece: VirtualPiece): number {
  return piece.tlA + (piece.srcB - piece.srcA);
}

export function clipSourceToTimeline(
  clip: TimedPlacement,
  sourceSec: number,
): number | null {
  for (const { srcA, srcB, tlA } of clipVirtualPieces(clip)) {
    if (srcA <= sourceSec && sourceSec < srcB) {
      return tlA + (sourceSec - srcA);
    }
  }
  return sourceSec === clip.source_end ? clipTimelineEnd(clip) : null;
}

export function clipTimelineToSource(
  clip: TimedPlacement,
  timelineSec: number,
): number | null {
  for (const piece of clipVirtualPieces(clip)) {
    if (piece.tlA <= timelineSec && timelineSec < pieceTimelineEnd(piece)) {
      return piece.srcA + (timelineSec - piece.tlA);
    }
  }
  return null;
}

export function piecesSourceToTimelineNearest(
  pieces: readonly VirtualPiece[],
  sourceSec: number,
): number {
  const first = pieces[0];
  const last = pieces[pieces.length - 1];
  if (!first || !last) {
    return sourceSec;
  }
  if (sourceSec < first.srcA) {
    return first.tlA + (sourceSec - first.srcA);
  }
  for (const { srcA, srcB, tlA } of pieces) {
    if (sourceSec < srcA) {
      return tlA;
    }
    if (sourceSec < srcB) {
      return tlA + (sourceSec - srcA);
    }
  }
  return last.tlA + (sourceSec - last.srcA);
}

export function clipSourceToTimelineNearest(
  clip: TimedPlacement,
  sourceSec: number,
): number {
  const pieces = clipVirtualPieces(clip);
  if (pieces.length === 0) {
    return clip.timeline_start + (sourceSec - clip.source_start);
  }
  return Math.min(
    piecesSourceToTimelineNearest(pieces, sourceSec),
    clipTimelineEnd(clip),
  );
}

const STEP_EDGE_EPS_SEC = 1e-6;

export function stepsWithin(
  timing: ClipRow["timing"],
  sourceStart: number,
  sourceEnd: number,
) {
  return (timing?.steps ?? []).filter(
    (step) =>
      sourceStart < step.at &&
      step.at < sourceEnd &&
      step.at + Math.max(0, -step.delta_sec) <= sourceEnd + STEP_EDGE_EPS_SEC,
  );
}

export function livePieces(
  clip: Pick<ClipRow, "timing">,
  sourceStart: number,
  sourceEnd: number,
  timelineStart: number,
): VirtualPiece[] {
  const steps = stepsWithin(clip.timing, sourceStart, sourceEnd);
  return clipVirtualPieces({
    source_start: sourceStart,
    source_end: sourceEnd,
    timeline_start: timelineStart,
    timing: clip.timing && { ...clip.timing, steps },
  });
}
