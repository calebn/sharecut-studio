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
};

type Heard = {
  text: string;
  key: string;
  start: number;
  word: TranscriptWordView;
};

function heardWords(utterance: CombinedUtterance): Heard[] {
  return (utterance.words ?? [])
    .flatMap((word, at) => {
      const start = wordSeekSec(word);
      if (word.suppressed || word.ignored || start === null) return [];
      return [
        {
          text: word.text,
          key: `${utterance.track_id}:${utterance.source_id ?? ""}:${word.word_index ?? at}`,
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
  const spoken = (utterances ?? [])
    .map((utterance) => {
      const heard = heardWords(utterance);
      return { utterance, heard, first: heard[0]?.start ?? 0 };
    })
    .filter(({ heard }) => heard.length > 0)
    .sort((a, b) => a.first - b.first);
  const colors = new Map<string, number>();
  const turns: ScriptTurn[] = [];
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
    turns.push({
      id: `${utterance.track_id}@${first}`,
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
  return { turns, wordStarts, words };
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

export function lastStartedWordAt(
  wordStarts: readonly number[],
  seconds: number,
): number | undefined {
  let best: number | undefined;
  wordStarts.forEach((start, index) => {
    if (start > seconds) return;
    if (best === undefined || start >= (wordStarts[best] ?? 0)) best = index;
  });
  return best;
}
