import type { ScriptTurn, ScriptWord } from "../../system/scriptPieces";
import type { CombinedUtterance } from "../../types/project";
import { formatTimeShort } from "../../utils/time";

export type GuestScriptModel = {
  turns: ScriptTurn[];
  /** Timeline second each word starts, by word index. Never decreases. */
  wordStarts: number[];
};

const PRESENCE_COLORS = 8;

type Heard = { text: string; key: string; start: number; end: number };

function heardWords(utterance: CombinedUtterance): Heard[] {
  const heard: Heard[] = [];
  (utterance.words ?? []).forEach((word, at) => {
    if (word.suppressed || word.ignored) return;
    if (typeof word.timeline_start !== "number") return;
    heard.push({
      text: word.text,
      key: `${utterance.track_id}:${utterance.source_id ?? ""}:${word.word_index ?? at}`,
      start: word.timeline_start,
      end: word.timeline_end ?? word.timeline_start,
    });
  });
  return heard.sort((a, b) => a.start - b.start);
}

/**
 * The words a guest hears, as Script turns: what the host cut or ignored is
 * left out, and so is any word with no place on the timeline. Turns are in
 * time order; overlapping speech can start a word earlier than the one before
 * it, so each start is held at the largest seen so far, which the playing-word
 * lookup needs.
 */
export function guestScriptOf(
  utterances: readonly CombinedUtterance[],
): GuestScriptModel {
  const spoken = utterances
    .map((utterance) => ({ utterance, heard: heardWords(utterance) }))
    .filter(({ heard }) => heard.length > 0)
    .sort((a, b) => (a.heard[0]?.start ?? 0) - (b.heard[0]?.start ?? 0));
  const colors = new Map<string, number>();
  const turns: ScriptTurn[] = [];
  const wordStarts: number[] = [];
  let previousEnd: number | null = null;
  for (const { utterance, heard } of spoken) {
    const first = heard[0]?.start ?? 0;
    const speaker = utterance.speaker;
    if (!colors.has(speaker))
      colors.set(speaker, colors.size % PRESENCE_COLORS);
    const words: ScriptWord[] = heard.map((word) => {
      const index = wordStarts.length;
      wordStarts.push(Math.max(word.start, wordStarts[index - 1] ?? 0));
      return { index, key: word.key, text: word.text };
    });
    turns.push({
      id: `${utterance.track_id}@${first}`,
      speakerId: speaker,
      speaker: { name: speaker, colorIndex: colors.get(speaker) ?? 0 },
      time: formatTimeShort(first),
      pauseBefore:
        previousEnd === null ? undefined : Math.max(0, first - previousEnd),
      words,
    });
    previousEnd = Math.max(...heard.map((word) => word.end));
  }
  return { turns, wordStarts };
}
