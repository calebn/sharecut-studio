import {
  type SegmentInsertApplied,
  type SegmentInsertAt,
  type SegmentInsertPreview,
  type SegmentInsertRefusal,
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
};

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

export function insertAtOf(
  position: InsertPosition,
  playheadSec: number,
  timelineEnd: number,
): SegmentInsertAt {
  if (position !== "playhead") return position;
  if (!Number.isFinite(playheadSec) || playheadSec >= timelineEnd) return "end";
  return Math.round(Math.max(0, playheadSec) * 1000) / 1000;
}

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

const laterText = (n: number, one: string, many: string) =>
  `${plural(n, one, many)} ${n === 1 ? "moves" : "move"} later.`;

export function insertPreviewLines(preview: SegmentInsertPreview): string[] {
  const lines = [
    `Adds ${formatTimeShort(preview.duration_sec)} at ${formatTimeShort(preview.at)}.`,
  ];
  if (preview.clips_moved > 0)
    lines.push(
      `Moves ${plural(preview.clips_moved, "clip", "clips")} later by ${formatTimeShort(preview.duration_sec)}.`,
    );
  else lines.push("Nothing moves.");
  const chapters = preview.chapters_moved.length;
  if (chapters > 0) lines.push(laterText(chapters, "chapter", "chapters"));
  const comments = preview.comments_moved.length;
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
  return `Inserted ${name}: ${formatTimeShort(applied.duration_sec)} at ${formatTimeShort(applied.at)}`;
}

export function segmentInsertQueuedMessage(name: string): string {
  return `${name} was sent for the host to apply`;
}
