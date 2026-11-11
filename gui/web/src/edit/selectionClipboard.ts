import { SPLIT_MICRO_FADE_MS } from "../types/limits.generated";
import type { ClipRow, ProjectView, Selection } from "../types/project";
import { clipFadeCurves } from "../utils/fadeCurves";
import { transcriptWordRange } from "../utils/transcript";
import type { ClipboardExtract, ClipboardPayload } from "./clipboard";
import { muteRegionsOverlapping } from "./muteRegions";

function findClip(project: ProjectView, id: string): ClipRow | null {
  const tracks = project.clips?.tracks ?? {};
  for (const clips of Object.values(tracks)) {
    for (const c of clips ?? []) {
      if (c.id === id) {
        return c;
      }
    }
  }
  return null;
}

function clipOverlapToSource(
  clip: ClipRow,
  ovStart: number,
  ovEnd: number,
): { sourceStart: number; sourceEnd: number } | null {
  const dur = clip.timeline_end - clip.timeline_start;
  const srcDur = clip.source_end - clip.source_start;
  if (!(dur > 0) || !(srcDur > 0)) {
    return null;
  }
  const rel0 = (ovStart - clip.timeline_start) / dur;
  const rel1 = (ovEnd - clip.timeline_start) / dur;
  return {
    sourceStart: clip.source_start + rel0 * srcDur,
    sourceEnd: clip.source_start + rel1 * srcDur,
  };
}

/**
 * What a range end that falls inside a clip gets in an extract. There is no
 * default; each caller names the rule (`clips_ops.RangeEdgeFade` on the server).
 * `cut`: the range end is a new edge, so it gets a linear `ms` fade (clamped to
 * the piece) and a fade join, never the clip's far-edge fade; Studio Cut uses
 * it, as `move_segment` and `duplicate_segment` do. `keep`: a plain copy keeps
 * the clip's own fades and curves, as `copy_segment` does.
 */
export type RangeEdgeFade = { kind: "keep" } | { kind: "cut"; ms: number };

export const KEEP_CLIP_FADES: RangeEdgeFade = { kind: "keep" };
export const CUT_EDGE_FADE: RangeEdgeFade = {
  kind: "cut",
  ms: SPLIT_MICRO_FADE_MS,
};

export function edgeFadeFor(mode: "copy" | "cut"): RangeEdgeFade {
  return mode === "cut" ? CUT_EDGE_FADE : KEEP_CLIP_FADES;
}

const EDGE_EPS_SEC = 1e-6;

function pieceMs(sourceStart: number, sourceEnd: number): number {
  return Math.max(0, Math.floor((sourceEnd - sourceStart) * 1000 + 1e-6));
}

/**
 * Extract relative clips in [timelineStart, timelineEnd) for paste after cut.
 * When trackIds is set, only those tracks; else all tracks with clips in range.
 * Mirrors `clips_ops.extract_clips_in_timeline_range`.
 */
export function extractClipsInRange(
  project: ProjectView,
  timelineStart: number,
  timelineEnd: number,
  edgeFade: RangeEdgeFade,
  trackIds?: string[],
): ClipboardExtract[] {
  const tracks = project.clips?.tracks ?? {};
  const allow = trackIds && trackIds.length > 0 ? new Set(trackIds) : null;
  const out: ClipboardExtract[] = [];
  for (const [tid, clips] of Object.entries(tracks)) {
    if (allow && !allow.has(tid)) {
      continue;
    }
    for (const clip of clips ?? []) {
      const ovStart = Math.max(timelineStart, clip.timeline_start);
      const ovEnd = Math.min(timelineEnd, clip.timeline_end);
      if (!(ovEnd > ovStart + 1e-9)) {
        continue;
      }
      const src = clipOverlapToSource(clip, ovStart, ovEnd);
      if (!src) {
        continue;
      }
      const cut = edgeFade.kind === "cut";
      const cutIn = cut && clip.timeline_start < timelineStart - EDGE_EPS_SEC;
      const cutOut = cut && clip.timeline_end > timelineEnd + EDGE_EPS_SEC;
      const cutMs = cut
        ? Math.min(edgeFade.ms, pieceMs(src.sourceStart, src.sourceEnd))
        : 0;
      const { fade_in_curve, fade_out_curve } = clipFadeCurves(clip);
      out.push({
        track_id: clip.track_id,
        source_start: src.sourceStart,
        source_end: src.sourceEnd,
        relative_timeline_start: ovStart - timelineStart,
        source_id: clip.source_id,
        fade_in_ms: cutIn ? cutMs : clip.fade_in_ms,
        fade_out_ms: cutOut ? cutMs : clip.fade_out_ms,
        ...(fade_in_curve && !cutIn ? { fade_in_curve } : {}),
        ...(fade_out_curve && !cutOut ? { fade_out_curve } : {}),
        gain_db: clip.gain_db,
        join_in_mode: cutIn ? "fade" : clip.join_in_mode,
        mute_regions: muteRegionsOverlapping(
          clip.mute_regions,
          src.sourceStart,
          src.sourceEnd,
        ),
      });
    }
  }
  return out;
}

export function rangeTimelineSpan(
  project: ProjectView,
  trackId: string,
  startWordIndex: number,
  endWordIndex: number,
  sourceId?: string | null,
): { start: number; end: number; text: string } | null {
  const span = transcriptWordRange(
    project,
    trackId,
    startWordIndex,
    endWordIndex,
    { sourceId },
  );
  return span && span.end > span.start ? span : null;
}

function finishPayload(
  project: ProjectView,
  timelineStart: number,
  timelineEnd: number,
  opts: {
    mode: "copy" | "cut";
    trackIds?: string[];
    plainText?: string;
  },
): ClipboardPayload | null {
  if (!(timelineEnd > timelineStart)) {
    return null;
  }
  const extracts = extractClipsInRange(
    project,
    timelineStart,
    timelineEnd,
    edgeFadeFor(opts.mode),
    opts.trackIds,
  );
  return {
    timelineStart,
    timelineEnd,
    mode: opts.mode,
    trackIds: opts.trackIds,
    plainText: opts.plainText,
    extracts,
  };
}

/**
 * Build clipboard payload from current selection.
 * Session-range (all dialogue) for transcript ranges; single-track for one clip.
 */
export function payloadFromSelection(
  project: ProjectView,
  selection: Selection,
  mode: "copy" | "cut" = "copy",
): ClipboardPayload | null {
  if (!selection) {
    return null;
  }
  if (selection.kind === "clip") {
    const clip = findClip(project, selection.id);
    if (!clip) {
      return null;
    }
    return finishPayload(project, clip.timeline_start, clip.timeline_end, {
      mode,
      trackIds: [clip.track_id],
    });
  }
  if (selection.kind === "transcriptRange") {
    const span = rangeTimelineSpan(
      project,
      selection.trackId,
      selection.startWordIndex,
      selection.endWordIndex,
      selection.sourceId,
    );
    if (!span) {
      return null;
    }
    return finishPayload(project, span.start, span.end, {
      mode,
      plainText: span.text,
    });
  }
  return null;
}
