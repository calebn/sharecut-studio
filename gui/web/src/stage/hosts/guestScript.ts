import type { ShownRow } from "../../document/shownTranscript";
import type { GuestEmpty } from "../../stages/guest/guestLogic";
import type { ScriptTurn, ScriptWord } from "../../system/scriptPieces";
import type {
  CombinedUtterance,
  TranscriptWordView,
} from "../../types/project";
import { formatTimeShort } from "../../utils/time";
import { isWordActive, wordSeekSec } from "../../utils/transcript";
import type { ScriptModel, ScriptWordRef } from "../edit/script/scriptModel";
import { wordKey } from "../edit/script/scriptModel";

export type GuestScriptModel = {
  turns: ScriptTurn[];
  /** Where a tap seeks; null for a held word, whose time is not known yet. */
  wordStarts: (number | null)[];
  words: TranscriptWordView[];
  refs: ScriptWordRef[];
  times: ({ start: number; end: number } | null)[];
  empty: GuestEmpty;
};

type Heard = {
  text: string;
  start: number | null;
  word: TranscriptWordView;
  at: number;
};

/** The words a live row draws, in time order. */
function heardWords(utterance: CombinedUtterance): Heard[] {
  return (utterance.words ?? [])
    .flatMap((word, at) => {
      const start = wordSeekSec(word);
      if (word.suppressed || word.ignored || start === null) return [];
      return [{ text: word.text, start, word, at }];
    })
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
}

type Entry = {
  utterance: CombinedUtterance;
  heard: Heard[];
  /** Characters of each word a waiting row will show; its words are not known yet. */
  settling?: number[];
  /** Where the row sits in reading order, and what its time label says. */
  first: number;
  /** When the row stops being heard, for the pause before the next turn. */
  until: number;
};

function entryOf(row: ShownRow): Entry | null {
  const { utterance } = row;
  const rowStart = utterance.timeline_start ?? 0;
  const rowEnd = utterance.timeline_end ?? rowStart;
  if (row.kind === "live") {
    const heard = heardWords(utterance);
    if (heard.length === 0) return null;
    return {
      utterance,
      heard,
      first: heard[0].start ?? 0,
      until: Math.max(
        ...heard.map(
          ({ word }) => word.timeline_end ?? word.timeline_start ?? 0,
        ),
      ),
    };
  }
  if (row.kind === "held") {
    const heard = (utterance.words ?? []).map((word, at) => ({
      text: word.text,
      start: null,
      word,
      at,
    }));
    return {
      utterance,
      heard,
      first: rowStart + row.lead,
      until: rowEnd,
    };
  }
  const settling = utterance.text
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .map((token) => token.length);
  return settling.length === 0
    ? null
    : { utterance, heard: [], settling, first: rowStart, until: rowEnd };
}

export function guestScriptOf(rows: readonly ShownRow[]): GuestScriptModel {
  const live = rows.flatMap((row) =>
    row.kind === "live" ? (row.utterance.words ?? []) : [],
  );
  const cut = (word: TranscriptWordView) =>
    word.suppressed || word.ignored || word.mappable === false;
  const unplaced = live.some(
    (word) => !cut(word) && wordSeekSec(word) === null,
  );
  const anyCut = live.some(cut);
  const spoken = rows
    .flatMap((row) => entryOf(row) ?? [])
    .sort((a, b) => a.first - b.first);
  const colors = new Map<string, number>();
  const turns: ScriptTurn[] = [];
  const turnIds = new Set<string>();
  const wordKeys = new Map<string, number>();
  const wordStarts: (number | null)[] = [];
  const words: TranscriptWordView[] = [];
  const refs: ScriptWordRef[] = [];
  const times: GuestScriptModel["times"] = [];
  let heardUntil: number | null = null;
  for (const { utterance, heard, settling, first, until } of spoken) {
    const speaker = utterance.speaker;
    let colorIndex = colors.get(speaker);
    if (colorIndex === undefined) {
      colorIndex = colors.size;
      colors.set(speaker, colorIndex);
    }
    const lane = `${utterance.track_id}:${utterance.source_id ?? ""}`;
    const scriptWords: ScriptWord[] = heard.map((item) => {
      const index = wordStarts.length;
      wordStarts.push(item.start);
      words.push(item.word);
      refs.push({
        trackId: utterance.track_id,
        sourceId: utterance.source_id ?? null,
        wordIndex: item.word.word_index ?? null,
      });
      times.push(
        item.start === null || item.word.timeline_end == null
          ? null
          : { start: item.start, end: item.word.timeline_end },
      );
      const base = `${lane}:${item.word.word_index ?? item.at}`;
      const repeat = wordKeys.get(base) ?? 0;
      wordKeys.set(base, repeat + 1);
      return {
        index,
        key: repeat === 0 ? base : `${base}#${repeat + 1}`,
        text: item.text,
      };
    });
    const base = `${lane}:${utterance.start}`;
    let id = base;
    for (let n = 2; turnIds.has(id); n += 1) id = `${base}#${n}`;
    turnIds.add(id);
    turns.push({
      id,
      speakerId: speaker,
      speaker: { name: speaker, colorIndex },
      time: formatTimeShort(first),
      pauseBefore:
        heardUntil === null ? undefined : Math.max(0, first - heardUntil),
      words: scriptWords,
      ...(settling ? { settling } : {}),
    });
    heardUntil = Math.max(heardUntil ?? 0, until);
  }
  const empty: GuestEmpty =
    rows.length === 0
      ? "none"
      : unplaced
        ? "unplaced"
        : anyCut
          ? "cut"
          : "untimed";
  return { turns, wordStarts, words, refs, times, empty };
}

/**
 * A selection across tracks becomes a time span, and a held word has no time,
 * so such a span would silently leave it out. Within one track a selection is
 * by word identity and needs no time.
 */
export function spansHeldAcrossTracks(
  g: GuestScriptModel,
  { anchor, head }: { anchor: number; head: number },
): boolean {
  const lo = Math.min(anchor, head);
  const hi = Math.max(anchor, head);
  const lanes = new Set<string>();
  let held = false;
  for (let at = lo; at <= hi; at++) {
    const ref = g.refs[at];
    if (!ref) continue;
    lanes.add(`${ref.trackId}:${ref.sourceId ?? ""}`);
    if (g.wordStarts[at] === null) held = true;
  }
  return held && lanes.size > 1;
}

export function playingWordsAt(
  words: readonly TranscriptWordView[],
  seconds: number,
): number[] {
  const playing: number[] = [];
  words.forEach((word, index) => {
    if (isWordActive(word, seconds)) playing.push(index);
  });
  return playing;
}

/** The pane's selection model over the guest's heard words: nothing is cut here. */
export function guestScriptModelOf(g: GuestScriptModel): ScriptModel {
  const first = new Map<string, number>();
  const last = new Map<string, number>();
  g.refs.forEach((ref, index) => {
    if (ref.wordIndex === null) return;
    const key = wordKey(ref);
    if (!first.has(key)) first.set(key, index);
    last.set(key, index);
  });
  return {
    turns: g.turns,
    refs: g.refs,
    indexOf: (ref, side = "first") =>
      ref.wordIndex === null
        ? undefined
        : (side === "first" ? first : last).get(wordKey(ref)),
    seekSecOf: (index) => g.wordStarts[index] ?? null,
    timeOf: (index) => g.times[index] ?? null,
    isCut: () => false,
  };
}
