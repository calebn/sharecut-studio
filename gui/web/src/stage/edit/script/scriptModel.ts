import type { PersonData } from "../../../system/Person";
import type {
  ScriptMark,
  ScriptSelection,
  ScriptTurn,
  ScriptWord,
  WordsSelection,
} from "../../../system/scriptPieces";
import type {
  CombinedUtterance,
  EditBoundaryView,
  PendingEditView,
  Selection,
  TranscriptWordView,
} from "../../../types/project";
import { formatTimeShort } from "../../../utils/time";
import {
  groupConsecutiveSpeakerTurns,
  turnSeekSec,
  wordsForUtterance,
} from "../../../utils/transcript";

/** Where a Script word lives in the project: the pane only knows its window index. */
export type ScriptWordRef = {
  trackId: string;
  sourceId: string | null;
  wordIndex: number;
};

export type ScriptModelInput = {
  /** Every utterance, cut-away ones included: the pane draws a cut as a pill or as struck text. */
  utterances: readonly CombinedUtterance[];
  /** Applied cuts. Each carries the words it took out. */
  boundaries: readonly EditBoundaryView[];
  /** Suggestions the words fall under. Applied ones are skipped. */
  pending: readonly PendingEditView[];
  /** Who speaks on a track, by name and colour. */
  person: (trackId: string, speaker: string) => PersonData;
};

export type ScriptModel = {
  turns: readonly ScriptTurn[];
  /** The project word behind each window index. */
  refs: readonly ScriptWordRef[];
  /** The window index of a project word, or undefined when the pane does not show it. */
  indexOf: (ref: ScriptWordRef) => number | undefined;
  /** Where the playhead goes for a window index: the word's start on the timeline, or null for a cut word. */
  seekSecOf: (index: number) => number | null;
  /** The word's span on the timeline, or null for a cut word. */
  timeOf: (index: number) => { start: number; end: number } | null;
};

/** Stable name for a word: the key the pane carries on `ScriptWord.key`. */
export function wordKey(ref: ScriptWordRef): string {
  return `${ref.trackId}:${ref.sourceId ?? ""}:${ref.wordIndex}`;
}

const NO_TIME = null;

function wordSeek(word: TranscriptWordView): number | null {
  if (word.mappable === false) return NO_TIME;
  return word.timeline_start ?? NO_TIME;
}

function overlaps(
  word: TranscriptWordView,
  from: number | null,
  to: number | null,
): boolean {
  if (from == null || to == null) return false;
  const mid = (word.start + word.end) / 2;
  return mid >= from && mid <= to;
}

/** Cut marks by word key: every word a boundary took out, with the seconds it removed. */
function cutMarks(
  boundaries: readonly EditBoundaryView[],
): Map<string, ScriptMark> {
  const marks = new Map<string, ScriptMark>();
  for (const boundary of boundaries) {
    if (!boundary.has_cutaway) continue;
    const seconds = Math.max(
      0,
      boundary.cutaway_source_end - boundary.cutaway_source_start,
    );
    for (const word of boundary.cutaway_word_ids) {
      marks.set(
        wordKey({
          trackId: word.track_id,
          sourceId: word.source_id,
          wordIndex: word.word_index,
        }),
        { kind: "cut", id: boundary.id, seconds },
      );
    }
  }
  return marks;
}

/** Pending edits that can mark words, by track, so a word only looks at its own track's edits. */
function pendingByTrack(
  pending: readonly PendingEditView[],
): Map<string, PendingEditView[]> {
  const byTrack = new Map<string, PendingEditView[]>();
  for (const edit of pending) {
    if (edit.applied || edit.source_start == null || edit.source_end == null) {
      continue;
    }
    for (const trackId of new Set([edit.track_id, ...(edit.track_ids ?? [])])) {
      const list = byTrack.get(trackId);
      if (list) list.push(edit);
      else byTrack.set(trackId, [edit]);
    }
  }
  return byTrack;
}

function suggestionFor(
  edits: readonly PendingEditView[] | undefined,
  word: TranscriptWordView,
): string | null {
  for (const edit of edits ?? []) {
    if (overlaps(word, edit.source_start, edit.source_end)) return edit.id;
  }
  return null;
}

function markOf(
  word: TranscriptWordView,
  cut: ScriptMark | undefined,
  suggestion: string | null,
): ScriptMark | undefined {
  if (cut) return cut;
  if (suggestion) return { kind: "suggested", id: suggestion };
  if (word.ignored || word.suppressed) return { kind: "muted" };
  return undefined;
}

/**
 * The project's transcript as the Script pane's turns. A turn is a run of
 * utterances by one speaker on one track, as the old transcript grouped them.
 * Window indices run over every word in order, so the pane's selection and
 * carets address words by one number and `refs` maps them back.
 */
export function buildScriptModel(input: ScriptModelInput): ScriptModel {
  const cuts = cutMarks(input.boundaries);
  const pending = pendingByTrack(input.pending);
  const grouped = groupConsecutiveSpeakerTurns([...input.utterances]);
  const refs: ScriptWordRef[] = [];
  const times: Array<{ start: number; end: number } | null> = [];
  const seeks: Array<number | null> = [];
  const byKey = new Map<string, number>();
  const turns: ScriptTurn[] = [];
  let previousEnd: number | null = null;

  for (const [turnAt, turn] of grouped.entries()) {
    const words: ScriptWord[] = [];
    let turnStart: number | null = null;
    let turnEnd: number | null = null;
    for (const utterance of turn.utterances) {
      for (const [at, word] of wordsForUtterance(utterance).entries()) {
        const ref: ScriptWordRef = {
          trackId: utterance.track_id,
          sourceId: utterance.source_id ?? null,
          wordIndex: word.word_index ?? at,
        };
        const key = wordKey(ref);
        const index = refs.length;
        refs.push(ref);
        byKey.set(key, index);
        const seek = wordSeek(word);
        seeks.push(seek);
        const end = word.timeline_end ?? NO_TIME;
        times.push(seek != null && end != null ? { start: seek, end } : null);
        if (seek != null) {
          turnStart = turnStart == null ? seek : Math.min(turnStart, seek);
          if (end != null) {
            turnEnd = turnEnd == null ? end : Math.max(turnEnd, end);
          }
        }
        const mark = markOf(
          word,
          cuts.get(key),
          suggestionFor(pending.get(utterance.track_id), word),
        );
        words.push({
          index,
          key,
          text: word.text,
          ...(mark ? { mark } : {}),
          ...(word.unsure === true ? { lowConfidence: true } : {}),
        });
      }
    }
    const startSec = turnSeekSec(turn) ?? turnStart;
    const pauseBefore =
      previousEnd != null && turnStart != null
        ? Math.max(0, turnStart - previousEnd)
        : undefined;
    turns.push({
      id: `${turn.trackId}:${turn.startIndex}:${turnAt}`,
      speakerId: turn.trackId,
      speaker: input.person(turn.trackId, turn.speaker),
      time: startSec == null ? "" : formatTimeShort(startSec),
      ...(pauseBefore != null ? { pauseBefore } : {}),
      words,
    });
    if (turnEnd != null) previousEnd = turnEnd;
  }

  return {
    turns,
    refs,
    indexOf: (ref) => byKey.get(wordKey(ref)),
    seekSecOf: (index) => seeks[index] ?? NO_TIME,
    timeOf: (index) => times[index] ?? NO_TIME,
  };
}

/**
 * What the pane shows for the store's selection. Only a run of words in one
 * track is a Script selection; anything else (a clip, a range across tracks,
 * a marker) leaves the pane with nothing selected.
 */
export function scriptSelectionOf(
  model: ScriptModel,
  selection: Selection | null,
): ScriptSelection | null {
  if (selection?.kind !== "transcriptRange") return null;
  const sourceId = selection.sourceId ?? null;
  const anchor = model.indexOf({
    trackId: selection.trackId,
    sourceId,
    wordIndex: selection.startWordIndex,
  });
  const head = model.indexOf({
    trackId: selection.trackId,
    sourceId,
    wordIndex: selection.endWordIndex,
  });
  if (anchor === undefined || head === undefined) return null;
  return { kind: "words", anchor, head };
}

/** What a settled words selection means for the project. */
export type WordsTarget =
  /** Every selected word is on one track: the store's `transcriptRange`. */
  | {
      kind: "track";
      trackId: string;
      sourceId: string | null;
      startWordIndex: number;
      endWordIndex: number;
    }
  /**
   * The selection crosses tracks, so it covers that time on every track it
   * touches (Caleb, 2026-10-28). `trackIds` are the tracks with a selected word.
   */
  | {
      kind: "time";
      start: number;
      end: number;
      trackIds: readonly string[];
    };

/**
 * The project meaning of a words selection, or null when it covers no word the
 * model knows. A time target needs timed words: a selection of cut words only
 * has no time and gives null.
 */
export function wordsTargetOf(
  model: ScriptModel,
  selection: WordsSelection,
): WordsTarget | null {
  const lo = Math.min(selection.anchor, selection.head);
  const hi = Math.max(selection.anchor, selection.head);
  const first = model.refs[lo];
  if (!first) return null;
  const tracks: string[] = [];
  let sameLane = true;
  let start: number | null = null;
  let end: number | null = null;
  for (let at = lo; at <= hi; at++) {
    const ref = model.refs[at];
    if (!ref) return null;
    if (!tracks.includes(ref.trackId)) tracks.push(ref.trackId);
    if (ref.trackId !== first.trackId || ref.sourceId !== first.sourceId) {
      sameLane = false;
    }
    const time = model.timeOf(at);
    if (time) {
      start = start == null ? time.start : Math.min(start, time.start);
      end = end == null ? time.end : Math.max(end, time.end);
    }
  }
  if (sameLane) {
    const last = model.refs[hi] ?? first;
    return {
      kind: "track",
      trackId: first.trackId,
      sourceId: first.sourceId,
      startWordIndex: Math.min(first.wordIndex, last.wordIndex),
      endWordIndex: Math.max(first.wordIndex, last.wordIndex),
    };
  }
  if (start == null || end == null) return null;
  return { kind: "time", start, end, trackIds: tracks };
}
