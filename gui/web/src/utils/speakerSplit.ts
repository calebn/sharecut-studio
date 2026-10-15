import { joinNames } from "../edit/cutSpeech";
import { resolveSelectionRange } from "../edit/rangeSelection";
import type {
  ExactRangeTarget,
  HistoryEntryId,
  ProjectView,
  Selection,
  TrackView,
} from "../types/project";
import { formatTimeShort } from "./time";
import { clipsForTrack, timelinePointToSource } from "./timebase";

/** Bounds the host's speaker count (the server enforces the same range). */
export const MIN_SPLIT_SPEAKERS = 2;
export const MAX_SPLIT_SPEAKERS = 8;

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
export type SplitSpeakersResult = {
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

/** A few seconds of one speaker, kept as the exact range that was selected. */
export type VoiceSample = {
  /** The selection as it was when marked, so Listen can play it again. */
  target: ExactRangeTarget;
  /** The same seconds on the recording's own clock, which is what enrollment takes. */
  sourceStart: number;
  sourceEnd: number;
};

/** A sample shorter than this is too little to recognise a voice by. */
export const MIN_VOICE_SAMPLE_SEC = 1;
/** Float noise allowed between a range's length on the timeline and on the recording. */
const SAMPLE_EDGE_EPS_SEC = 1e-3;

/**
 * The selected range as a voice sample of `trackId`, or why it cannot be one.
 * Enrollment spans are source seconds (`TOOL_TIMEBASE.speaker_split_tool`), so the
 * timeline range is mapped through the track's clip.
 */
export function voiceSampleFromSelection(
  project: ProjectView | null,
  selection: Selection,
  trackId: string | null,
): { sample: VoiceSample; reason: null } | { sample: null; reason: string } {
  const none = (reason: string) => ({ sample: null, reason });
  if (!project || trackId == null) return none("Open a project");
  const { targets, reason } = resolveSelectionRange(project, selection);
  const target = targets.length === 1 ? targets[0]! : null;
  if (!target) return none(reason ?? "Select a range on the timeline first");
  if (target.intervals.length !== 1)
    return none("Select one stretch of the track");
  if (!target.track_ids.includes(trackId))
    return none("Select the range on the track being split");
  const { start, end } = target.intervals[0]!;
  if (end - start < MIN_VOICE_SAMPLE_SEC)
    return none(
      `Select at least ${MIN_VOICE_SAMPLE_SEC} second of one person talking`,
    );
  const clips = clipsForTrack(project.clips?.tracks, trackId);
  const sourceStart = timelinePointToSource(clips, start);
  const lastInside = timelinePointToSource(clips, end - SAMPLE_EDGE_EPS_SEC);
  if (sourceStart == null || lastInside == null)
    return none("Select audio that is on the track");
  const sourceEnd = lastInside + SAMPLE_EDGE_EPS_SEC;
  const ms = (sec: number) => Math.round(sec * 1000) / 1000;
  if (Math.abs(sourceEnd - sourceStart - (end - start)) > SAMPLE_EDGE_EPS_SEC)
    return none("The range crosses a cut. Select within one stretch.");
  return {
    sample: { target, sourceStart: ms(sourceStart), sourceEnd: ms(sourceEnd) },
    reason: null,
  };
}

/** `{name: [[start, end]]}` in source seconds for the speakers that have a sample. */
export function splitSpeakersEnrollment(
  names: readonly string[] | null,
  samples: ReadonlyArray<VoiceSample | null | undefined>,
): Record<string, Array<[number, number]>> | null {
  const out: Record<string, Array<[number, number]>> = {};
  names?.forEach((name, i) => {
    const sample = samples[i];
    if (sample) out[name] = [[sample.sourceStart, sample.sourceEnd]];
  });
  return Object.keys(out).length ? out : null;
}

/**
 * Names to send: what was typed, "Speaker N" for blanks, null when nothing was typed.
 * A sample belongs to a name, so `named` asks for names even when none were typed.
 */
export function splitSpeakerNames(
  typed: readonly string[],
  count: number,
  named = false,
): string[] | null {
  const names = Array.from({ length: count }, (_, i) => typed[i]?.trim() ?? "");
  if (!named && names.every((name) => name === "")) {
    return null;
  }
  return names.map((name, i) => name || `Speaker ${i + 1}`);
}

export function splitSpeakersRequestBlocker(
  count: number | null,
  names: readonly string[] | null,
): string | null {
  if (
    count == null ||
    !Number.isInteger(count) ||
    count < MIN_SPLIT_SPEAKERS ||
    count > MAX_SPLIT_SPEAKERS
  ) {
    return `Enter ${MIN_SPLIT_SPEAKERS} to ${MAX_SPLIT_SPEAKERS} speakers.`;
  }
  if (names && new Set(names.map((n) => n.toLowerCase())).size < names.length) {
    return "Give each speaker a different name.";
  }
  return null;
}

function seconds(sec: number): string {
  return sec < 60 ? `${Math.round(sec)} s` : formatTimeShort(sec);
}

export function splitSpeakersDoneCopy(
  result: SplitSpeakersResult,
  trackLabel: string,
): string {
  const names = joinNames(result.lanes.map((lane) => lane.name));
  return `Split ${trackLabel} into ${result.lanes.length} tracks: ${names}.`;
}

/** What the person should listen to before relying on the tracks. */
export function splitSpeakersListenNotes(
  result: SplitSpeakersResult,
): string[] {
  const notes: string[] = [];
  if (result.low_confidence_sec >= 1) {
    notes.push(
      `${seconds(result.low_confidence_sec)} where the speaker is unclear. Listen there before relying on the tracks.`,
    );
  }
  if (result.crosstalk_sec >= 1) {
    notes.push(
      `${seconds(result.crosstalk_sec)} where people talk over each other. It plays once, on the track of the speaker heard most.`,
    );
  }
  return notes;
}
