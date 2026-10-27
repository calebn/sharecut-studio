import { selectedClipIdsOf } from "../state/selection";
import type {
  PendingEditView,
  ProjectView,
  Selection,
  TimelineSpan,
} from "../types/project";
import { isRemovalRecord } from "../utils/appliedRecords";
import { findTranscriptWord } from "../utils/transcript";
import { roomToneGaps } from "./roomToneGaps";
import { rangeTimelineSpan } from "./selectionClipboard";

export type EditKind =
  | "playhead"
  | "words"
  | "range"
  | "clip"
  | "seam"
  | "appliedEdge"
  | "suggestion"
  | "chapter"
  | "social"
  | "comment"
  | "track"
  | "envelope"
  | "envelopePoint"
  | "bleed";

export type PendingSuggestedAction = NonNullable<
  PendingEditView["suggested_action"]
> | null;

/** `readOnly` is a Viewer or Commenter guest. */
export type EditRole = "host" | "editor" | "readOnly";

/** `trackIds` is empty for a span that belongs to the whole session. */
export type EditSpan = TimelineSpan & { readonly trackIds: readonly string[] };

/** What the Action bar needs to know about a selection. Every field is defined for every kind. */
export interface EditFacts {
  readonly kind: EditKind;
  /** Clips, tracks or words held; 1 for any other object, 0 for the playhead. */
  readonly count: number;
  readonly span: EditSpan | null;
  /** Words: any selected word is suppressed. Range: it overlaps an applied removal. Seam: always. */
  readonly holdsCut: boolean;
  /** A room-tone fill would cover time between clips in this range. */
  readonly hasGap: boolean;
  /** The pending edit's table default, which names the suggestion's primary verb. */
  readonly suggestedAction: PendingSuggestedAction;
  readonly commentResolved: boolean;
  readonly clipboardHasAudio: boolean;
  readonly role: EditRole;
}

/** A removal record is a seam. A mute, trim, split, roll, fill or move is an edge with no cut to restore. */
export function selectionKind(
  selection: Selection,
  project: ProjectView,
): EditKind {
  if (selection === null) return "playhead";
  switch (selection.kind) {
    case "transcriptRange":
      return "words";
    case "range":
      return "range";
    case "clip":
      return "clip";
    case "applied": {
      const record = project.applied_edits.records.find(
        (entry) => entry.id === selection.id,
      );
      return record && isRemovalRecord(record) ? "seam" : "appliedEdge";
    }
    case "pending":
      return "suggestion";
    case "chapter":
      return "chapter";
    case "social":
      return "social";
    case "comment":
      return "comment";
    case "track":
      return "track";
    case "envelope":
      return "envelope";
    case "envelopePoint":
      return "envelopePoint";
    case "bleedAttenuation":
      return "bleed";
    default: {
      const unhandled: never = selection;
      return unhandled;
    }
  }
}

function hull(
  spans: readonly TimelineSpan[],
  trackIds: readonly string[],
): EditSpan | null {
  if (!spans.length) return null;
  return {
    start: Math.min(...spans.map((span) => span.start)),
    end: Math.max(...spans.map((span) => span.end)),
    trackIds,
  };
}

/** The timeline time a selection covers, or null for a kind with no single footprint (playhead, track, envelope point, bleed region). */
export function selectionSpan(
  selection: Selection,
  project: ProjectView,
): EditSpan | null {
  if (selection === null) return null;
  switch (selection.kind) {
    case "transcriptRange": {
      const span = rangeTimelineSpan(
        project,
        selection.trackId,
        selection.startWordIndex,
        selection.endWordIndex,
        selection.sourceId,
      );
      return span
        ? { start: span.start, end: span.end, trackIds: [selection.trackId] }
        : null;
    }
    case "range":
      return hull(selection.target.intervals, selection.target.track_ids);
    case "clip": {
      const ids = new Set(selectedClipIdsOf(selection));
      const clips = Object.values(project.clips.tracks)
        .flat()
        .filter((clip) => ids.has(clip.id));
      return hull(
        clips.map((clip) => ({
          start: clip.timeline_start,
          end: clip.timeline_end,
        })),
        [...new Set(clips.map((clip) => clip.track_id))],
      );
    }
    case "applied": {
      const record = project.applied_edits.records.find(
        (entry) => entry.id === selection.id,
      );
      if (record?.timeline_start == null || record.timeline_end == null)
        return null;
      return {
        start: record.timeline_start,
        end: record.timeline_end,
        trackIds: record.track_ids,
      };
    }
    case "pending": {
      const edit = project.pending_edits.find(
        (entry) => entry.id === selection.id,
      );
      if (edit?.timeline_start == null || edit.timeline_end == null)
        return null;
      return {
        start: edit.timeline_start,
        end: edit.timeline_end,
        trackIds: edit.track_ids ?? [edit.track_id],
      };
    }
    case "chapter":
      return { start: selection.time, end: selection.time, trackIds: [] };
    case "social": {
      const clip = project.social_clips.find(
        (entry) => entry.id === selection.id,
      );
      return clip
        ? { start: clip.start, end: clip.end, trackIds: [clip.track_id] }
        : null;
    }
    case "comment": {
      const comment = project.comments.find(
        (entry) => entry.id === selection.id,
      );
      return comment
        ? {
            start: comment.timeline_start,
            end: comment.timeline_end ?? comment.timeline_start,
            trackIds: comment.track_ids,
          }
        : null;
    }
    case "track":
    case "envelope":
    case "envelopePoint":
    case "bleedAttenuation":
      return null;
    default: {
      const unhandled: never = selection;
      return unhandled;
    }
  }
}

function overlapsAppliedCut(span: EditSpan, project: ProjectView): boolean {
  return project.applied_edits.records.some(
    (record) =>
      isRemovalRecord(record) &&
      record.timeline_start != null &&
      record.timeline_end != null &&
      record.timeline_start < span.end &&
      record.timeline_end > span.start &&
      (record.track_ids.length === 0 ||
        span.trackIds.some((id) => record.track_ids.includes(id))),
  );
}

function holdsCutWord(
  selection: Extract<Selection, { kind: "transcriptRange" }>,
  project: ProjectView,
): boolean {
  const lo = Math.min(selection.startWordIndex, selection.endWordIndex);
  const hi = Math.max(selection.startWordIndex, selection.endWordIndex);
  for (let index = lo; index <= hi; index++) {
    const word = findTranscriptWord(
      project,
      selection.trackId,
      index,
      selection.sourceId,
    );
    if (word?.suppressed) return true;
  }
  return false;
}

function holdsCutOf(
  selection: Selection,
  kind: EditKind,
  span: EditSpan | null,
  project: ProjectView,
): boolean {
  if (selection?.kind === "applied") return kind === "seam";
  if (selection?.kind === "transcriptRange")
    return holdsCutWord(selection, project);
  return kind === "range" && span !== null && overlapsAppliedCut(span, project);
}

function countOf(selection: Selection): number {
  if (selection === null) return 0;
  switch (selection.kind) {
    case "clip":
      return selectedClipIdsOf(selection).length;
    case "track":
      return (selection.trackIds ?? [selection.trackId]).length;
    case "transcriptRange":
      return Math.abs(selection.endWordIndex - selection.startWordIndex) + 1;
    default:
      return 1;
  }
}

/** Pure: reads nothing but its arguments. Callers memoize on `(selection, project)`. */
export function editFacts(
  selection: Selection,
  project: ProjectView,
  ctx: { readonly role: EditRole; readonly clipboardHasAudio: boolean },
): EditFacts {
  const kind = selectionKind(selection, project);
  const span = selectionSpan(selection, project);
  const range = selection?.kind === "range" ? selection.target : null;
  return {
    kind,
    count: countOf(selection),
    span,
    holdsCut: holdsCutOf(selection, kind, span, project),
    hasGap: range !== null && roomToneGaps(project, range).length > 0,
    suggestedAction:
      selection?.kind === "pending"
        ? (project.pending_edits.find((edit) => edit.id === selection.id)
            ?.suggested_action ?? null)
        : null,
    commentResolved:
      selection?.kind === "comment" &&
      (project.comments.find((comment) => comment.id === selection.id)
        ?.resolved ??
        false),
    clipboardHasAudio: ctx.clipboardHasAudio,
    role: ctx.role,
  };
}
