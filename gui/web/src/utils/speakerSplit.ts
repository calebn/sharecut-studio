import { joinNames } from "../edit/cutSpeech";
import type { HistoryEntryId, TrackView } from "../types/project";
import { formatTimeShort } from "./time";

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

export type SplitSpeakersLane = {
  track_id: string;
  name: string;
  /** Seconds of the recording this track is silent for, where another speaker talks. */
  muted_sec: number;
};

export type SplitSpeakersSamePair = {
  speakers: string[];
};

/** `SpeakerService.split_speakers`'s result, as the `split_speakers` job carries it. */
export type SplitSpeakersResult = {
  lanes: SplitSpeakersLane[];
  crosstalk_sec: number;
  low_confidence_sec: number;
  same_voice: SplitSpeakersSamePair[];
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
  const sameVoice = Array.isArray(raw.same_voice) ? raw.same_voice : [];
  const head = raw.history_head_id;
  return {
    lanes,
    crosstalk_sec:
      typeof raw.crosstalk_sec === "number" ? raw.crosstalk_sec : 0,
    low_confidence_sec:
      typeof raw.low_confidence_sec === "number" ? raw.low_confidence_sec : 0,
    same_voice: sameVoice.filter(
      (pair): pair is SplitSpeakersSamePair =>
        isRecord(pair) &&
        Array.isArray(pair.speakers) &&
        pair.speakers.length === 2 &&
        pair.speakers.every((name) => typeof name === "string"),
    ),
    history_head_id: typeof head === "string" ? (head as HistoryEntryId) : null,
  };
}

/** Names to send: what was typed, "Speaker N" for blanks, null when nothing was typed. */
export function splitSpeakerNames(
  typed: readonly string[],
  count: number,
): string[] | null {
  const names = Array.from({ length: count }, (_, i) => typed[i]?.trim() ?? "");
  if (names.every((name) => name === "")) {
    return null;
  }
  return names.map((name, i) => name || `Speaker ${i + 1}`);
}

/** Why Split speakers is disabled in the dialog, or null when the request is fine. */
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

/** Status line for a finished split. */
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
  const notes = result.same_voice.map(
    ({ speakers }) =>
      `${joinNames(speakers)} sound like one person. If fewer people are talking, undo and split again with a lower count.`,
  );
  if (result.low_confidence_sec >= 1) {
    notes.push(
      `${seconds(result.low_confidence_sec)} where it is not sure who is talking. Listen there before relying on the tracks.`,
    );
  }
  if (result.crosstalk_sec >= 1) {
    notes.push(
      `${seconds(result.crosstalk_sec)} where people talk over each other. It plays once, on the track of the speaker it hears most.`,
    );
  }
  return notes;
}
