import type { PersonData } from "./Person";
import type { ScriptMark, ScriptTurn, ScriptWord } from "./scriptPieces";

const MAYA: PersonData = { name: "Maya Okafor", colorIndex: 0 };
const ANNEKE: PersonData = { name: "Anneke de Vries", colorIndex: 1 };

function wordsOf(text: string, from: number): ScriptWord[] {
  return text.split(" ").map((word, at) => ({
    index: from + at,
    key: `episode:${from + at}`,
    text: word,
  }));
}

/** Four turns, 54 words, indices 0 to 53. The third turn continues the second speaker's. */
export const SCRIPT_TURNS: readonly ScriptTurn[] = [
  {
    id: "t1",
    speakerId: "maya",
    speaker: MAYA,
    time: "12:04",
    words: wordsOf(
      "Welcome back to the show. Today we are talking about how a small room can sound like a large one.",
      0,
    ),
  },
  {
    id: "t2",
    speakerId: "anneke",
    speaker: ANNEKE,
    time: "12:19",
    pauseBefore: 1.4,
    words: wordsOf(
      "Thanks for having me. The first season was mostly about getting the room right, and then we found the microphones.",
      20,
    ),
  },
  {
    id: "t3",
    speakerId: "anneke",
    speaker: ANNEKE,
    time: "12:41",
    pauseBefore: 1.1,
    words: wordsOf("That changed everything for us.", 40),
  },
  {
    id: "t4",
    speakerId: "maya",
    speaker: MAYA,
    time: "12:47",
    pauseBefore: 0.8,
    words: wordsOf("So, um, you know, what did you buy first?", 45),
  },
];

/** The same turns with the given words changed, found by index. */
export function patchWords(
  turns: readonly ScriptTurn[],
  patches: Readonly<Record<number, Partial<ScriptWord>>>,
): ScriptTurn[] {
  return turns.map((turn) => ({
    ...turn,
    words: turn.words.map((word) => ({ ...word, ...patches[word.index] })),
  }));
}

/** One patch for every index from `start` to `end`. */
export function spanPatch(
  start: number,
  end: number,
  patch: Partial<ScriptWord>,
): Record<number, Partial<ScriptWord>> {
  return Object.fromEntries(
    Array.from({ length: end - start + 1 }, (_, at) => [start + at, patch]),
  );
}

/** A cut that took 1.1 s: its three words plus the pauses between them. */
export const CUT: ScriptMark = { kind: "cut", id: "cut-1", seconds: 1.1 };

export const cutMark = (id: string, seconds: number): ScriptMark => ({
  kind: "cut",
  id,
  seconds,
});

export const suggestedMark = (id: string): ScriptMark => ({
  kind: "suggested",
  id,
});

export const MUTED: ScriptMark = { kind: "muted" };
