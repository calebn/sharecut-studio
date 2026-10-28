import type {
  ExactRangeTarget,
  HistoryEntryId,
  ProjectView,
  TrackView,
} from "../types/project";

/** Why Split speakers cannot run on `track`, or null when it can. */
export function splitSpeakersBlocker(
  track: Pick<TrackView, "media_path" | "speaker_split_id"> | undefined,
  canManage: boolean,
): string | null {
  if (!canManage) {
    return "Host-only (not available on review links)";
  }
  if (!track) {
    return "Select a track to split";
  }
  if (track.speaker_split_id) {
    return "This track is already split by speaker. Undo the split to split it again.";
  }
  if (!track.media_path) {
    return "Import this track's audio first";
  }
  return null;
}

/** Sibling speaker-split tracks of `trackId`, or none when it is not a split lane. */
export function siblingSplitLanes<
  T extends Pick<TrackView, "id" | "speaker_split_id">,
>(tracks: readonly T[], trackId: string): T[] {
  const track = tracks.find((candidate) => candidate.id === trackId);
  if (!track?.speaker_split_id) {
    return [];
  }
  return tracks.filter(
    (candidate) =>
      candidate.speaker_split_id === track.speaker_split_id &&
      candidate.id !== trackId,
  );
}

export function speakerLaneMoveTarget(
  project: ProjectView | null,
  target: ExactRangeTarget | null,
): { fromLaneId: string; interval: { start: number; end: number } } | null {
  if (!project || !target || target.track_ids.length !== 1) return null;
  if (target.intervals.length !== 1) return null;
  const fromLaneId = target.track_ids[0]!;
  if (!siblingSplitLanes(project.tracks, fromLaneId).length) return null;
  const interval = target.intervals[0]!;
  if (!(interval.end > interval.start)) return null;
  return { fromLaneId, interval };
}

export type SplitSpeakersLane = {
  track_id: string;
  name: string;
  /** Seconds of the recording this track is silent for, where another speaker talks. */
  muted_sec: number;
};

export type SplitSpeakerReviewSpan = {
  start_s: number;
  end_s: number;
  speakers: string[];
  unsure: boolean;
  overlapping: boolean;
  timeline_spans: Array<{ start_s: number; end_s: number }>;
};

/** `SpeakerService.split_speakers`'s result, as the `split_speakers` job carries it. */
type SplitSpeakersResult = {
  split_id: string;
  lanes: SplitSpeakersLane[];
  crosstalk_sec: number;
  low_confidence_sec: number;
  review_spans: SplitSpeakerReviewSpan[];
  history_head_id: HistoryEntryId | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Reads a finished job's result; null when it is not a split result. */
export function parseSplitSpeakersResult(
  raw: unknown,
): SplitSpeakersResult | null {
  if (!isRecord(raw) || !Array.isArray(raw.lanes)) {
    return null;
  }
  if (typeof raw.split_id !== "string") return null;
  const lanes = raw.lanes.filter(
    (lane): lane is SplitSpeakersLane =>
      isRecord(lane) &&
      typeof lane.track_id === "string" &&
      typeof lane.name === "string" &&
      typeof lane.muted_sec === "number",
  );
  if (lanes.length < 2) {
    return null;
  }
  const laneIds = new Set(lanes.map((lane) => lane.track_id));
  const reviewSpans = Array.isArray(raw.review_spans)
    ? raw.review_spans.flatMap((span): SplitSpeakerReviewSpan[] => {
        if (
          !isRecord(span) ||
          typeof span.start_s !== "number" ||
          !Number.isFinite(span.start_s) ||
          typeof span.end_s !== "number" ||
          !Number.isFinite(span.end_s) ||
          span.start_s < 0 ||
          span.end_s <= span.start_s ||
          !Array.isArray(span.speakers) ||
          span.speakers.length === 0 ||
          !span.speakers.every(
            (speaker) => typeof speaker === "string" && laneIds.has(speaker),
          ) ||
          typeof span.unsure !== "boolean" ||
          typeof span.overlapping !== "boolean" ||
          (!span.unsure && !span.overlapping) ||
          !Array.isArray(span.timeline_spans)
        ) {
          return [];
        }
        const timelineSpans = span.timeline_spans.flatMap(
          (timelineSpan): Array<{ start_s: number; end_s: number }> =>
            isRecord(timelineSpan) &&
            typeof timelineSpan.start_s === "number" &&
            Number.isFinite(timelineSpan.start_s) &&
            typeof timelineSpan.end_s === "number" &&
            Number.isFinite(timelineSpan.end_s) &&
            timelineSpan.start_s >= 0 &&
            timelineSpan.end_s > timelineSpan.start_s
              ? [{ start_s: timelineSpan.start_s, end_s: timelineSpan.end_s }]
              : [],
        );
        return [
          {
            start_s: span.start_s,
            end_s: span.end_s,
            speakers: span.speakers,
            unsure: span.unsure,
            overlapping: span.overlapping,
            timeline_spans: timelineSpans,
          },
        ];
      })
    : [];
  const head = raw.history_head_id;
  return {
    split_id: raw.split_id,
    lanes,
    crosstalk_sec:
      typeof raw.crosstalk_sec === "number" ? raw.crosstalk_sec : 0,
    low_confidence_sec:
      typeof raw.low_confidence_sec === "number" ? raw.low_confidence_sec : 0,
    review_spans: reviewSpans,
    history_head_id: typeof head === "string" ? (head as HistoryEntryId) : null,
  };
}

export function splitSpeakersDoneCopy(
  result: SplitSpeakersResult,
  trackLabel: string,
): string {
  const names = joinNames(result.lanes.map((lane) => lane.name));
  return `Split ${trackLabel} into ${result.lanes.length} tracks: ${names}.`;
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}
