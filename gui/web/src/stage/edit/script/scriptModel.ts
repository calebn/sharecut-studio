import { transcriptWordPresenceAnchor } from "../../../presence/anchors";
import type { PersonData } from "../../../system/Person";
import type {
  ScriptMark,
  ScriptSelection,
  ScriptTurn,
  ScriptWord,
  WordsSelection,
} from "../../../system/scriptPieces";
import { placeEditBoundaries } from "../../../transcript/editBoundaryPlacement";
import type {
  CombinedUtterance,
  EditBoundaryView,
  PendingEditView,
  Selection,
  TranscriptWordView,
} from "../../../types/project";
import { pendingKind } from "../../../utils/editMarkerRegistry";
import { pendingEditTrackIds } from "../../../utils/edits";
import { formatTimeShort } from "../../../utils/time";
import {
  groupConsecutiveSpeakerTurns,
  turnSeekSec,
  wordsForUtterance,
} from "../../../utils/transcript";

/**
 * Where a Script word lives in the project: the pane only knows its window index.
 * `wordIndex` is null for a word the project gives no index (a row that has no
 * word timings): it can be shown and seeked but never addressed.
 */
export type ScriptWordRef = {
  trackId: string;
  sourceId: string | null;
  wordIndex: number | null;
};

export type ScriptModelInput = {
  /** The utterances to show. Words an applied cut took out are not among them: the boundaries carry those. */
  utterances: readonly CombinedUtterance[];
  /** Applied cuts. Each carries the words it took out, which the model puts back as cut words at the join. */
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
  /**
   * The window index of a project word, or undefined when the pane does not show
   * it. A word listed under two utterances (a word straddling them) has two:
   * `first` (default) gives the earlier one, `last` the later one.
   */
  indexOf: (ref: ScriptWordRef, side?: "first" | "last") => number | undefined;
  /** Where the playhead goes for a window index: the word's start on the timeline, or null for a cut word. */
  seekSecOf: (index: number) => number | null;
  /** The word's span on the timeline, or null for a cut word. */
  timeOf: (index: number) => { start: number; end: number } | null;
  /** Whether the word is one an applied cut took out. */
  isCut: (index: number) => boolean;
};

/** The speaker palette has eight colours; a track takes one by its position. */
export function speakerColorIndex(trackPosition: number): number {
  return Math.max(trackPosition, 0) % 8;
}

/** Stable name for a word: the key the pane carries on `ScriptWord.key`. */
export function wordKey(ref: ScriptWordRef): string {
  return `${ref.trackId}:${ref.sourceId ?? ""}:${ref.wordIndex ?? ""}`;
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

/** Pending cuts that can mark words, by track, so a word only looks at its own track's edits. */
function pendingByTrack(
  pending: readonly PendingEditView[],
): Map<string, PendingEditView[]> {
  const byTrack = new Map<string, PendingEditView[]>();
  for (const edit of pending) {
    if (
      edit.applied ||
      edit.source_start == null ||
      edit.source_end == null ||
      pendingKind(edit.type) !== "pending-remove"
    ) {
      continue;
    }
    for (const trackId of pendingEditTrackIds(edit)) {
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
  suggestion: string | null,
): ScriptMark | undefined {
  if (suggestion) return { kind: "suggested", id: suggestion };
  if (word.ignored || word.suppressed) return { kind: "muted" };
  return undefined;
}

/** A word on its way into the model, before window indices are handed out. */
type DraftWord = {
  ref: ScriptWordRef;
  text: string;
  seek: number | null;
  end: number | null;
  mark?: ScriptMark;
  lowConfidence: boolean;
  /** A word an applied cut took out: shown, never seeked or addressed. */
  cut: boolean;
};

type DraftTurn = {
  trackId: string;
  speaker: string;
  startSec: number | null;
  words: DraftWord[];
};

/** The words a boundary took out, as cut words to show at its join. */
function cutWordsOf(boundary: EditBoundaryView): DraftWord[] {
  const seconds = Math.max(
    0,
    boundary.cutaway_source_end - boundary.cutaway_source_start,
  );
  return boundary.cutaway_word_ids.map((word) => ({
    ref: {
      trackId: word.track_id,
      sourceId: word.source_id,
      wordIndex: word.word_index,
    },
    text: word.text,
    seek: NO_TIME,
    end: NO_TIME,
    mark: { kind: "cut", id: boundary.id, seconds },
    lowConfidence: false,
    cut: true,
  }));
}

/**
 * The project's transcript as the Script pane's turns. A turn is a run of
 * utterances by one speaker on one track, as the old transcript grouped them.
 * An applied cut leaves no words in the utterances, so its boundary puts them
 * back as cut words where the join falls. Window indices run over every word in
 * order, so the pane's selection and carets address words by one number and
 * `refs` maps them back.
 */
export function buildScriptModel(input: ScriptModelInput): ScriptModel {
  const pending = pendingByTrack(input.pending);
  const grouped = groupConsecutiveSpeakerTurns([...input.utterances]);
  const drafts: DraftTurn[] = grouped.map((turn) => {
    const words: DraftWord[] = [];
    for (const utterance of turn.utterances) {
      for (const word of wordsForUtterance(utterance)) {
        const mark = markOf(
          word,
          suggestionFor(pending.get(utterance.track_id), word),
        );
        words.push({
          ref: {
            trackId: utterance.track_id,
            sourceId: utterance.source_id ?? null,
            wordIndex: word.word_index ?? null,
          },
          text: word.text,
          seek: wordSeek(word),
          end: word.timeline_end ?? NO_TIME,
          ...(mark ? { mark } : {}),
          lowConfidence: word.unsure === true,
          cut: false,
        });
      }
    }
    return {
      trackId: turn.trackId,
      speaker: turn.speaker,
      startSec: turnSeekSec(turn),
      words,
    };
  });

  const boundaries = input.boundaries.filter(
    (boundary) => boundary.has_cutaway && boundary.cutaway_word_ids.length > 0,
  );
  const placements = placeEditBoundaries(
    drafts.map((turn) => ({
      trackId: turn.trackId,
      words: turn.words.map((w) => ({
        timelineStart: w.seek ?? Number.POSITIVE_INFINITY,
        timelineEnd: w.end ?? Number.POSITIVE_INFINITY,
      })),
    })),
    boundaries,
  );
  // Later positions first, so earlier insertions keep their word offsets.
  for (const placement of [...placements].reverse()) {
    drafts[placement.turnIndex]?.words.splice(
      placement.afterWordIndex + 1,
      0,
      ...cutWordsOf(placement.boundary),
    );
  }

  const refs: ScriptWordRef[] = [];
  const times: Array<{ start: number; end: number } | null> = [];
  const cutAt: boolean[] = [];
  const seeks: Array<number | null> = [];
  const first = new Map<string, number>();
  const last = new Map<string, number>();
  const seen = new Map<string, number>();
  const turns: ScriptTurn[] = [];
  let previousEnd: number | null = null;

  for (const [turnAt, draft] of drafts.entries()) {
    const words: ScriptWord[] = [];
    let turnStart: number | null = null;
    let turnEnd: number | null = null;
    for (const word of draft.words) {
      const index = refs.length;
      refs.push(word.ref);
      seeks.push(word.seek);
      cutAt.push(word.cut);
      times.push(
        word.seek != null && word.end != null
          ? { start: word.seek, end: word.end }
          : null,
      );
      if (word.seek != null) {
        turnStart =
          turnStart == null ? word.seek : Math.min(turnStart, word.seek);
        if (word.end != null) {
          turnEnd = turnEnd == null ? word.end : Math.max(turnEnd, word.end);
        }
      }
      // A word with no index has no project name: key it by where it sits.
      const base =
        word.ref.wordIndex == null
          ? `${wordKey(word.ref)}@${index}`
          : wordKey(word.ref);
      const repeat = seen.get(base) ?? 0;
      seen.set(base, repeat + 1);
      if (word.ref.wordIndex != null) {
        if (!first.has(base)) first.set(base, index);
        last.set(base, index);
      }
      words.push({
        index,
        key: repeat === 0 ? base : `${base}~${repeat + 1}`,
        text: word.text,
        ...(word.ref.wordIndex != null && !word.cut
          ? {
              anchor: transcriptWordPresenceAnchor(
                word.ref.trackId,
                word.ref.sourceId,
                word.ref.wordIndex,
              ),
            }
          : {}),
        ...(word.mark ? { mark: word.mark } : {}),
        ...(word.lowConfidence ? { lowConfidence: true } : {}),
      });
    }
    const startSec = draft.startSec ?? turnStart;
    const pauseBefore =
      previousEnd != null && turnStart != null
        ? Math.max(0, turnStart - previousEnd)
        : undefined;
    turns.push({
      id: `${draft.trackId}:${words[0]?.key ?? turnAt}`,
      speakerId: draft.trackId,
      speaker: input.person(draft.trackId, draft.speaker),
      time: startSec == null ? "" : formatTimeShort(startSec),
      ...(pauseBefore != null ? { pauseBefore } : {}),
      words,
    });
    if (turnEnd != null) previousEnd = turnEnd;
  }

  return {
    turns,
    refs,
    indexOf: (ref, side = "first") =>
      ref.wordIndex == null
        ? undefined
        : (side === "first" ? first : last).get(wordKey(ref)),
    seekSecOf: (index) => seeks[index] ?? NO_TIME,
    timeOf: (index) => times[index] ?? NO_TIME,
    isCut: (index) => cutAt[index] === true,
  };
}

/**
 * What the pane shows for the store's selection. Only a run of words in one
 * track, or a range across tracks, is a Script selection; anything else (a clip,
 * a marker) leaves the pane with nothing selected.
 */
export function scriptSelectionOf(
  model: ScriptModel,
  selection: Selection | null,
): ScriptSelection | null {
  if (selection?.kind === "range") return rangeSelectionOf(model, selection);
  if (selection?.kind !== "transcriptRange") return null;
  const sourceId = selection.sourceId ?? null;
  const anchor = model.indexOf({
    trackId: selection.trackId,
    sourceId,
    wordIndex: selection.startWordIndex,
  });
  const head = model.indexOf(
    {
      trackId: selection.trackId,
      sourceId,
      wordIndex: selection.endWordIndex,
    },
    "last",
  );
  if (anchor === undefined || head === undefined) return null;
  return { kind: "words", anchor, head };
}

/** Whether any word of the model carries this mark: the Script draws the seam or suggestion. */
function modelHasMark(
  model: ScriptModel,
  kind: "cut" | "suggested",
  id: string,
): boolean {
  return model.turns.some((turn) =>
    turn.words.some((w) => w.mark?.kind === kind && w.mark.id === id),
  );
}

/**
 * What the pane shows for the store's selection once the seam and suggestion
 * the Script draws are counted. Words and ranges come first; a selected pending
 * edit is the suggestion with that id; an open join popover (it opens by the
 * join's right clip) is the cut seam of that join. Anything the Script does not
 * draw selects nothing.
 */
export function scriptReviewSelectionOf(
  model: ScriptModel,
  selection: Selection | null,
  boundaries: readonly EditBoundaryView[],
  openJoinId: string | null,
): ScriptSelection | null {
  const words = scriptSelectionOf(model, selection);
  if (words) return words;
  if (
    selection?.kind === "pending" &&
    modelHasMark(model, "suggested", selection.id)
  ) {
    return { kind: "suggestion", id: selection.id };
  }
  if (selection !== null || openJoinId === null) return null;
  const seam = boundaries.find((b) => b.right_clip_id === openJoinId);
  return seam && modelHasMark(model, "cut", seam.id)
    ? { kind: "cut", id: seam.id }
    : null;
}

/** How far a word's time may stray from a stored range edge and still lie inside it. */
const RANGE_EDGE_SEC = 1e-3;

/**
 * A stored `range` (what a selection across tracks becomes) as the Script's
 * words: from the first to the last uncut word, on a track the range covers,
 * that lies inside its time.
 */
function rangeSelectionOf(
  model: ScriptModel,
  selection: Extract<Selection, { kind: "range" }>,
): ScriptSelection | null {
  const { intervals, track_ids: tracks } = selection.target;
  const lo = Math.min(...intervals.map((r) => r.start)) - RANGE_EDGE_SEC;
  const hi = Math.max(...intervals.map((r) => r.end)) + RANGE_EDGE_SEC;
  let first: number | undefined;
  let last: number | undefined;
  for (let at = 0; at < model.refs.length; at++) {
    const ref = model.refs[at];
    const time = model.timeOf(at);
    if (!ref || !time || model.isCut(at) || !tracks.includes(ref.trackId))
      continue;
    if (time.start < lo || time.end > hi) continue;
    first ??= at;
    last = at;
  }
  return first === undefined || last === undefined
    ? null
    : { kind: "words", anchor: first, head: last };
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
  const tracks: string[] = [];
  let first: ScriptWordRef | null = null;
  let last: ScriptWordRef | null = null;
  let sameLane = true;
  let start: number | null = null;
  let end: number | null = null;
  for (let at = lo; at <= hi; at++) {
    const ref = model.refs[at];
    if (!ref) return null;
    // A cut is its own selection: the words it took out are not part of a range.
    if (model.isCut(at)) continue;
    if (!tracks.includes(ref.trackId)) tracks.push(ref.trackId);
    if (first == null) first = ref;
    last = ref;
    if (ref.trackId !== first.trackId || ref.sourceId !== first.sourceId) {
      sameLane = false;
    }
    const time = model.timeOf(at);
    if (time) {
      start = start == null ? time.start : Math.min(start, time.start);
      end = end == null ? time.end : Math.max(end, time.end);
    }
  }
  if (first == null || last == null) return null;
  if (sameLane) {
    const indices = model.refs
      .slice(lo, hi + 1)
      .flatMap((ref, at) =>
        model.isCut(lo + at) || ref.wordIndex == null ? [] : [ref.wordIndex],
      );
    if (indices.length > 0) {
      return {
        kind: "track",
        trackId: first.trackId,
        sourceId: first.sourceId,
        startWordIndex: Math.min(...indices),
        endWordIndex: Math.max(...indices),
      };
    }
  }
  if (start == null || end == null) return null;
  return { kind: "time", start, end, trackIds: tracks };
}
