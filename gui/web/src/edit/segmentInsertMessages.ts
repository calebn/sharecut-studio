import {
  type SegmentInsertApplied,
  type SegmentInsertAt,
  type SegmentInsertPreview,
  type SegmentInsertRefusal,
  type SegmentPlacement,
  type SegmentRow,
  segmentInsertRefusal,
} from "../api";
import { formatTimeShort } from "../utils/time";

export type InsertPosition = "start" | "end" | "playhead";

export const INSERT_POSITIONS: readonly InsertPosition[] = [
  "start",
  "end",
  "playhead",
];

export const INSERT_FAILED = "That did not insert. Try again.";
export const PREVIEW_FAILED = "The preview is not available. Try again.";

const REFUSALS: Record<SegmentInsertRefusal, string> = {
  segment_unknown:
    "That segment is no longer in your library. Pick another one.",
  segment_version_invalid:
    "That version of the segment is not in your library. Pick the segment again.",
  segment_unreadable:
    "That segment cannot be read. Pick another one, or save it again.",
  segment_busy:
    "Your library is busy with another action. Try again in a moment.",
  segment_hash_mismatch:
    "The audio of that segment has changed since it was saved. Save it again, then insert.",
  segment_media_invalid:
    "The audio of that segment cannot be used. Save it again, then insert.",
  segment_write_failed:
    "The audio could not be copied into this project. Check that there is room on the disk, then try again.",
  segment_position_out_of_range:
    "That position is past the end of the episode. Pick another position.",
  segment_placement_unsupported:
    "Dialogue segments cannot have their own lane. Choose Move the rest later.",
  segment_placement_invalid:
    "That placement is not available. Pick a placement again.",
};

export const PLACEMENT_OPTIONS: readonly {
  value: SegmentPlacement;
  label: string;
  hint: string;
}[] = [
  {
    value: "ripple",
    label: "Move the rest later",
    hint: "Later clips, chapters and comments shift by the segment's length.",
  },
  {
    value: "own_lane",
    label: "Play over the episode",
    hint: "Nothing moves. The segment is added on new tracks of its own.",
  },
];

export const DIALOGUE_OWN_LANE_HINT =
  "Dialogue segments always move later content. They cannot have their own lane.";

export const isDialogueSegment = (row: SegmentRow | null): boolean =>
  row?.role === "dialogue";

export function segmentInsertMessage(error: unknown): string {
  const refusal = segmentInsertRefusal(error);
  return refusal ? REFUSALS[refusal] : INSERT_FAILED;
}

export function segmentPreviewMessage(error: unknown): string {
  const refusal = segmentInsertRefusal(error);
  return refusal ? REFUSALS[refusal] : PREVIEW_FAILED;
}

export function defaultInsertPosition(kind: string): InsertPosition {
  if (kind === "intro") return "start";
  if (kind === "outro") return "end";
  return "playhead";
}

export function defaultPlacement(row: SegmentRow | null): SegmentPlacement {
  return row?.role === "music" ? "own_lane" : "ripple";
}

export function insertAtOf(
  position: InsertPosition,
  playheadSec: number,
  timelineEnd: number,
): SegmentInsertAt {
  if (position !== "playhead") return position;
  if (!Number.isFinite(playheadSec)) return "end";
  const seconds = Math.round(Math.max(0, playheadSec) * 1000) / 1000;
  return seconds >= timelineEnd ? "end" : seconds;
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

const laterText = (n: number, one: string, many: string) =>
  `${plural(n, one, many)} ${n === 1 ? "moves" : "move"} later.`;

const duckingLine = (row: SegmentRow | null): string =>
  row?.duck_under_dialogue === true
    ? "It plays at full level over the voices. Ducking is a separate step (podcast edit duck)."
    : row?.role === "music"
      ? "It plays at full level until you run ducking (podcast edit duck), which lowers music under speech."
      : "It plays at full level. It was not saved to duck under dialogue.";

function ownLanePreviewLines(
  preview: SegmentInsertPreview,
  row: SegmentRow | null,
): string[] {
  const tracks = preview.tracks_added.length;
  const where = tracks > 1 ? `${tracks} new tracks` : "a new track";
  return [
    `Adds ${formatTimeShort(preview.duration_sec)} at ${formatTimeShort(preview.at)} on ${where}.`,
    "Nothing already in the episode moves.",
    duckingLine(row),
    `The episode becomes ${formatTimeShort(preview.timeline_duration_after_sec)} long.`,
  ];
}

export function insertPreviewLines(
  preview: SegmentInsertPreview,
  placement: SegmentPlacement = "ripple",
  row: SegmentRow | null = null,
): string[] {
  if (placement === "own_lane") return ownLanePreviewLines(preview, row);
  const lines = [
    `Adds ${formatTimeShort(preview.duration_sec)} at ${formatTimeShort(preview.at)}.`,
  ];
  if (preview.clips_moved > 0)
    lines.push(
      `Moves ${plural(preview.clips_moved, "clip", "clips")} later by ${formatTimeShort(preview.duration_sec)}.`,
    );
  const chapters = preview.chapters_moved.length;
  const comments = preview.comments_moved.length;
  if (
    preview.clips_moved === 0 &&
    chapters === 0 &&
    comments === 0 &&
    preview.pending_edits_moved === 0
  )
    lines.push("Nothing moves.");
  if (chapters > 0) lines.push(laterText(chapters, "chapter", "chapters"));
  if (comments > 0) lines.push(laterText(comments, "comment", "comments"));
  if (preview.pending_edits_moved > 0)
    lines.push(
      laterText(preview.pending_edits_moved, "pending edit", "pending edits"),
    );
  const lanes = preview.tracks_added.length;
  if (lanes > 0)
    lines.push(lanes === 1 ? "Adds a new lane." : `Adds ${lanes} new lanes.`);
  lines.push(
    `The episode becomes ${formatTimeShort(preview.timeline_duration_after_sec)} long.`,
  );
  return lines;
}

export function segmentInsertedMessage(
  name: string,
  applied: SegmentInsertApplied,
): string {
  const where = applied.placement === "own_lane" ? " over the episode" : "";
  return `Inserted ${name}${where}: ${formatTimeShort(applied.duration_sec)} at ${formatTimeShort(applied.at)}`;
}

export function segmentInsertQueuedMessage(name: string): string {
  return `Insert of ${name} queued. Reconnect to send it.`;
}
