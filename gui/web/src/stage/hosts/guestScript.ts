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
  wordStarts: number[];
  words: TranscriptWordView[];
  refs: ScriptWordRef[];
  times: ({ start: number; end: number } | null)[];
  empty: GuestEmpty;
};

type Heard = {
  text: string;
  key: string;
  start: number;
  word: TranscriptWordView;
};

function heardWords(utterance: CombinedUtterance, ordinal: number): Heard[] {
  return (utterance.words ?? [])
    .flatMap((word, at) => {
      const start = wordSeekSec(word);
      if (word.suppressed || word.ignored || start === null) return [];
      return [
        {
          text: word.text,
          key: `${ordinal}:${utterance.track_id}:${utterance.source_id ?? ""}:${word.word_index ?? at}`,
          start,
          word,
        },
      ];
    })
    .sort((a, b) => a.start - b.start);
}

export function guestScriptOf(
  utterances: readonly CombinedUtterance[] | undefined,
): GuestScriptModel {
  const all = (utterances ?? []).flatMap((utterance) => utterance.words ?? []);
  const cut = (word: TranscriptWordView) =>
    word.suppressed || word.ignored || word.mappable === false;
  const unplaced = all.some((word) => !cut(word) && wordSeekSec(word) === null);
  const anyCut = all.some(cut);
  const spoken = (utterances ?? [])
    .map((utterance, at) => {
      const heard = heardWords(utterance, at);
      return { utterance, heard, first: heard[0]?.start ?? 0 };
    })
    .filter(({ heard }) => heard.length > 0)
    .sort((a, b) => a.first - b.first);
  const colors = new Map<string, number>();
  const turns: ScriptTurn[] = [];
  const taken = new Set<string>();
  const wordStarts: number[] = [];
  const words: TranscriptWordView[] = [];
  const refs: ScriptWordRef[] = [];
  const times: GuestScriptModel["times"] = [];
  let heardUntil: number | null = null;
  for (const { utterance, heard, first } of spoken) {
    const speaker = utterance.speaker;
    let colorIndex = colors.get(speaker);
    if (colorIndex === undefined) {
      colorIndex = colors.size;
      colors.set(speaker, colorIndex);
    }
    const scriptWords: ScriptWord[] = heard.map((item) => {
      const index = wordStarts.length;
      wordStarts.push(item.start);
      words.push(item.word);
      refs.push({
        trackId: utterance.track_id,
        sourceId: utterance.source_id ?? null,
        wordIndex: item.word.word_index ?? null,
      });
      times.push({
        start: item.word.timeline_start ?? item.start,
        end: item.word.timeline_end ?? item.start,
      });
      return { index, key: item.key, text: item.text };
    });
    const base = `${utterance.track_id}@${first}`;
    let id = base;
    for (let n = 2; taken.has(id); n += 1) id = `${base}#${n}`;
    taken.add(id);
    turns.push({
      id,
      speakerId: speaker,
      speaker: { name: speaker, colorIndex },
      time: formatTimeShort(first),
      pauseBefore:
        heardUntil === null ? undefined : Math.max(0, first - heardUntil),
      words: scriptWords,
    });
    heardUntil = Math.max(
      heardUntil ?? 0,
      ...heard.map(({ word }) => word.timeline_end ?? word.timeline_start ?? 0),
    );
  }
  const empty: GuestEmpty =
    (utterances?.length ?? 0) === 0
      ? "none"
      : unplaced
        ? "unplaced"
        : anyCut
          ? "cut"
          : "untimed";
  return { turns, wordStarts, words, refs, times, empty };
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
