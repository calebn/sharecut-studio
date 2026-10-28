import type { GuestEmpty } from "../../stages/guest/guestLogic";
import type { ScriptTurn, ScriptWord } from "../../system/scriptPieces";
import type {
  CombinedUtterance,
  TranscriptWordView,
} from "../../types/project";
import { formatTimeShort } from "../../utils/time";
import { isWordActive, wordSeekSec } from "../../utils/transcript";

export type GuestScriptModel = {
  turns: ScriptTurn[];
  wordStarts: number[];
  words: TranscriptWordView[];
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
  return { turns, wordStarts, words, empty };
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
