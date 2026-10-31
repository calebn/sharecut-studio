import type { PresenceSelection } from "../system/Presence";
import type { ProjectView } from "../types/project";
import type { SessionClient, SessionSelection } from "../types/session";
import { sortedVolumePoints } from "../utils/envelopes";
import { transcriptWordRange } from "../utils/transcript";

/** Narrowest remote span (px): a clip or a one-word transcript selection stays visible at any zoom. */
export const SPAN_MIN_PX = 2;
/** Width of a remote pending or applied point selection (px). */
export const POINT_PX = 2;
/** Width of a remote envelope-point selection (px). */
export const ENVELOPE_POINT_PX = 5;

type Span = { laneId: string; start: number; end: number; minPx: number };

function clipSpan(project: ProjectView, id: string): Span | null {
  for (const [trackId, clips] of Object.entries(project.clips.tracks)) {
    const clip = clips.find((c) => c.id === id);
    if (clip) {
      return {
        laneId: trackId,
        start: clip.timeline_start,
        end: clip.timeline_end,
        minPx: SPAN_MIN_PX,
      };
    }
  }
  return null;
}

function transcriptSpan(
  project: ProjectView,
  sel: SessionSelection,
): Span | null {
  if (
    (sel.kind !== "transcriptWord" && sel.kind !== "transcriptRange") ||
    !sel.track_id ||
    sel.word_index == null
  ) {
    return null;
  }
  const range = transcriptWordRange(
    project,
    sel.track_id,
    sel.word_index,
    sel.kind === "transcriptRange"
      ? (sel.word_end ?? sel.word_index)
      : sel.word_index,
    { boundsOnly: true, sourceId: sel.source_id ?? null },
  );
  if (!range) return null;
  return {
    laneId: sel.track_id,
    start: range.start,
    end: range.end,
    minPx: SPAN_MIN_PX,
  };
}

function selectionSpan(project: ProjectView, sel: SessionSelection) {
  if (sel.kind === "clip" && sel.id) return clipSpan(project, sel.id);
  if (
    (sel.kind === "pending" || sel.kind === "applied") &&
    sel.track_id &&
    sel.time != null
  ) {
    return {
      laneId: sel.track_id,
      start: sel.time,
      end: sel.time,
      minPx: POINT_PX,
    };
  }
  if (sel.kind === "envelopePoint" && sel.track_id && sel.id) {
    const point = sortedVolumePoints(project.envelopes, sel.track_id).find(
      (item) => item.id === sel.id,
    );
    if (!point) return null;
    return {
      laneId: sel.track_id,
      start: point.time,
      end: point.time,
      minPx: ENVELOPE_POINT_PX,
    };
  }
  return transcriptSpan(project, sel);
}

/**
 * What each remote client has selected, as System/Presence draws it. Every
 * span is at least its legacy width in px at this zoom (a point has none of
 * its own), so the leaf, which draws nothing for an empty span, still shows
 * it. A selection whose track or clip is gone is left out. Rebuild on zoom:
 * the minimum is a px width turned into seconds.
 */
export function presenceSelections(
  clients: readonly SessionClient[],
  project: ProjectView | null,
  pxPerSecond: number,
): PresenceSelection[] {
  if (project === null || !(pxPerSecond > 0)) return [];
  const out: PresenceSelection[] = [];
  for (const client of clients) {
    const sel = client.meta?.selection;
    if (!sel) continue;
    const span = selectionSpan(project, sel);
    if (span === null || !project.tracks.some((t) => t.id === span.laneId)) {
      continue;
    }
    out.push({
      id: client.client_id,
      personId: client.client_id,
      laneId: span.laneId,
      start: span.start,
      end: Math.max(span.end, span.start + span.minPx / pxPerSecond),
      colorIndex: client.meta?.color_index ?? 0,
    });
  }
  return out;
}
