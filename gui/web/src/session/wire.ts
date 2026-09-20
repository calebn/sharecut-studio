import type { AutomationEnvelope, Selection } from "../types/project";
import type { SessionSelection, ViewerSessionSnapshot } from "../types/session";
import {
  indexOfVolumePointAtTime,
  sortedVolumePoints,
} from "../utils/envelopes";

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
  if (sel.kind === "pending" || sel.kind === "applied") {
    return { kind: sel.kind, id: sel.id, track_id: sel.trackId };
  }
  if (sel.kind === "track") {
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
    const pt = sortedVolumePoints(envelopes, sel.trackId)[sel.index];
    if (!pt) {
      return null;
    }
    return {
      kind: "envelopePoint",
      track_id: sel.trackId,
      time: pt.time,
    };
  }
  return null;
}

export function selectionFromWire(
  sel: SessionSelection | null | undefined,
  envelopes?: AutomationEnvelope[],
): Selection {
  if (!sel) {
    return null;
  }
  if (sel.kind === "clip" && sel.id && sel.track_id) {
    return { kind: "clip", id: sel.id, trackId: sel.track_id };
  }
  if ((sel.kind === "pending" || sel.kind === "applied") && sel.id) {
    return {
      kind: sel.kind,
      id: sel.id,
      trackId: sel.track_id ?? "",
    };
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
  if (sel.kind === "envelopePoint" && sel.track_id && sel.time != null) {
    const index = indexOfVolumePointAtTime(envelopes, sel.track_id, sel.time);
    if (index < 0) {
      return null;
    }
    return {
      kind: "envelopePoint",
      trackId: sel.track_id,
      index,
    };
  }
  return null;
}
