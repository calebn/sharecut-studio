import type {
  AutomationEnvelope,
  ProjectView,
  Selection,
} from "../types/project";
import type { SessionSelection, ViewerSessionSnapshot } from "../types/session";
import { sortedVolumePoints } from "../utils/envelopes";

export function selectionToWire(
  sel: Selection,
  envelopes?: AutomationEnvelope[],
): ViewerSessionSnapshot["selection"] {
  if (!sel) {
    return null;
  }
  if (sel.kind === "clip") {
    return { kind: "clip", id: sel.id, track_id: sel.trackId };
  }
  if (sel.kind === "pending") {
    return { kind: "pending", id: sel.id, track_id: sel.trackId };
  }
  if (sel.kind === "applied") {
    return sel.trackId
      ? { kind: "applied", id: sel.id, track_id: sel.trackId }
      : { kind: "applied", id: sel.id };
  }
  if (sel.kind === "track" || sel.kind === "envelope") {
    return { kind: "track", track_id: sel.trackId };
  }
  if (sel.kind === "chapter") {
    return { kind: "chapter", id: sel.id, time: sel.time };
  }
  if (sel.kind === "social") {
    return { kind: "social", id: sel.id };
  }
  if (sel.kind === "comment") {
    return { kind: "comment", id: sel.id };
  }
  if (sel.kind === "transcriptWord") {
    return {
      kind: "transcriptWord",
      track_id: sel.trackId,
      word_index: sel.wordIndex,
    };
  }
  if (sel.kind === "transcriptRange") {
    return {
      kind: "transcriptRange",
      track_id: sel.trackId,
      word_index: sel.startWordIndex,
      word_end: sel.endWordIndex,
    };
  }
  if (sel.kind === "envelopePoint") {
    const pt = sortedVolumePoints(envelopes, sel.trackId).find(
      (point) => point.id === sel.pointId,
    );
    if (!pt) {
      return null;
    }
    return {
      kind: "envelopePoint",
      track_id: sel.trackId,
      id: pt.id,
      time: pt.time,
    };
  }
  return null;
}

/**
 * The local selection a wire selection names, or null when it is malformed or
 * its target is not in `project`, so a remote selection never opens an
 * inspector on something that is gone.
 */
export function selectionFromWire(
  sel: SessionSelection | null | undefined,
  project: ProjectView | null | undefined,
): Selection {
  const parsed = parseWireSelection(sel, project?.envelopes);
  return parsed && project && selectionExists(parsed, project) ? parsed : null;
}

function selectionExists(
  sel: NonNullable<Selection>,
  project: ProjectView,
): boolean {
  switch (sel.kind) {
    case "clip":
      return Object.values(project.clips.tracks).some((clips) =>
        clips.some((c) => c.id === sel.id),
      );
    case "pending":
      return project.pending_edits.some((e) => e.id === sel.id);
    case "applied":
      return project.applied_edits.records.some((r) => r.id === sel.id);
    case "social":
      return (project.social_clips ?? []).some((c) => c.id === sel.id);
    case "comment":
      return (project.comments ?? []).some((c) => c.id === sel.id);
    case "track":
    case "envelope":
    case "envelopePoint":
    case "transcriptWord":
    case "transcriptRange":
      return project.tracks.some((t) => t.id === sel.trackId);
    case "chapter":
    case "range":
      return true;
  }
}

function parseWireSelection(
  sel: SessionSelection | null | undefined,
  envelopes: AutomationEnvelope[] | undefined,
): Selection {
  if (!sel) {
    return null;
  }
  if (sel.kind === "clip" && sel.id && sel.track_id) {
    return { kind: "clip", id: sel.id, trackId: sel.track_id };
  }
  if (sel.kind === "pending" && sel.id) {
    return { kind: "pending", id: sel.id, trackId: sel.track_id ?? "" };
  }
  if (sel.kind === "applied" && sel.id) {
    return sel.track_id
      ? { kind: "applied", id: sel.id, trackId: sel.track_id }
      : { kind: "applied", id: sel.id };
  }
  if (sel.kind === "track" && sel.track_id) {
    return { kind: "track", trackId: sel.track_id };
  }
  if (sel.kind === "chapter" && sel.id != null && sel.time != null) {
    return { kind: "chapter", id: sel.id, time: sel.time };
  }
  if (sel.kind === "social" && sel.id) {
    return { kind: "social", id: sel.id };
  }
  if (sel.kind === "comment" && sel.id) {
    return { kind: "comment", id: sel.id };
  }
  if (sel.kind === "transcriptWord" && sel.track_id && sel.word_index != null) {
    return {
      kind: "transcriptWord",
      trackId: sel.track_id,
      wordIndex: sel.word_index,
    };
  }
  if (
    sel.kind === "transcriptRange" &&
    sel.track_id &&
    sel.word_index != null &&
    sel.word_end != null
  ) {
    return {
      kind: "transcriptRange",
      trackId: sel.track_id,
      startWordIndex: sel.word_index,
      endWordIndex: sel.word_end,
    };
  }
  if (sel.kind === "envelopePoint" && sel.track_id && sel.id) {
    const point = sortedVolumePoints(envelopes, sel.track_id).find(
      (point) => point.id === sel.id,
    );
    return point
      ? { kind: "envelopePoint", trackId: sel.track_id, pointId: point.id }
      : null;
  }
  return null;
}

/**
 * The store patch for a remote selection: the selection when `project` has its
 * target, else none, with the wire selection held pending so it resolves when
 * the project arrives or the target reaches this client (see
 * `selectionFromWire`).
 */
export function wireSelectionPatch(
  sel: SessionSelection | null | undefined,
  project: ProjectView | null | undefined,
): {
  selection: Selection;
  pendingWireSelection: SessionSelection | null;
} {
  const selection = selectionFromWire(sel, project);
  return {
    selection,
    pendingWireSelection: sel && !selection ? sel : null,
  };
}
