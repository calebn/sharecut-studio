import type { ClipRow, ProjectView, Selection } from "../types/project";
import type { ClipboardExtract, ClipboardPayload } from "./clipboard";

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

/** Keep mute holes that overlap [srcStart, srcEnd). */
function intersectMuteRegions(
  regions: { start_s: number; end_s: number }[] | undefined,
  srcStart: number,
  srcEnd: number,
): { start_s: number; end_s: number }[] {
  const out: { start_s: number; end_s: number }[] = [];
  for (const region of regions ?? []) {
    const start = Math.max(region.start_s, srcStart);
    const end = Math.min(region.end_s, srcEnd);
    if (end > start + 1e-9) {
      out.push({ start_s: start, end_s: end });
    }
  }
  return out;
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
 * Extract relative clips in [timelineStart, timelineEnd) for paste after cut.
 * When trackIds is set, only those tracks; else all tracks with clips in range.
 */
export function extractClipsInRange(
  project: ProjectView,
  timelineStart: number,
  timelineEnd: number,
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
      out.push({
        track_id: clip.track_id,
        source_start: src.sourceStart,
        source_end: src.sourceEnd,
        relative_timeline_start: ovStart - timelineStart,
        source_id: clip.source_id,
        fade_in_ms: clip.fade_in_ms,
        fade_out_ms: clip.fade_out_ms,
        join_in_mode: clip.join_in_mode,
        mute_regions: intersectMuteRegions(
          clip.mute_regions,
          src.sourceStart,
          src.sourceEnd,
        ),
      });
    }
  }
  return out;
}

/** Resolve timeline span for a transcript word index on a track. */
export function wordTimelineSpan(
  project: ProjectView,
  trackId: string,
  wordIndex: number,
): { start: number; end: number; text: string } | null {
  for (const u of project.transcript?.utterances ?? []) {
    if (u.track_id !== trackId) {
      continue;
    }
    for (const w of u.words ?? []) {
      if (w.word_index === wordIndex) {
        const start = w.timeline_start ?? w.start;
        const end = w.timeline_end ?? w.end;
        if (!(end > start)) {
          return null;
        }
        return { start, end, text: w.text };
      }
    }
  }
  return null;
}

export function rangeTimelineSpan(
  project: ProjectView,
  trackId: string,
  startWordIndex: number,
  endWordIndex: number,
): { start: number; end: number; text: string } | null {
  const lo = Math.min(startWordIndex, endWordIndex);
  const hi = Math.max(startWordIndex, endWordIndex);
  let start = Infinity;
  let end = -Infinity;
  const texts: string[] = [];
  for (const u of project.transcript?.utterances ?? []) {
    if (u.track_id !== trackId) {
      continue;
    }
    for (const w of u.words ?? []) {
      const wi = w.word_index;
      if (wi == null || wi < lo || wi > hi) {
        continue;
      }
      const s = w.timeline_start ?? w.start;
      const e = w.timeline_end ?? w.end;
      start = Math.min(start, s);
      end = Math.max(end, e);
      texts.push(w.text);
    }
  }
  if (!(end > start) || !Number.isFinite(start)) {
    return null;
  }
  return { start, end, text: texts.join(" ") };
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
  if (selection.kind === "transcriptWord") {
    const span = wordTimelineSpan(
      project,
      selection.trackId,
      selection.wordIndex,
    );
    if (!span) {
      return null;
    }
    return finishPayload(project, span.start, span.end, {
      mode,
      plainText: span.text,
    });
  }
  if (selection.kind === "transcriptRange") {
    const span = rangeTimelineSpan(
      project,
      selection.trackId,
      selection.startWordIndex,
      selection.endWordIndex,
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
