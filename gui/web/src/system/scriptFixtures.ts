import type { PersonData } from "./Person";
import type {
  ScriptMark,
  ScriptSpan,
  ScriptTurn,
  ScriptWord,
} from "./scriptPieces";

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

/** The words under `span` read as one string, as a Fix text field starts. */
export function textOfSpan(
  turns: readonly ScriptTurn[],
  span: ScriptSpan,
): string {
  return turns
    .flatMap((turn) => turn.words)
    .filter((word) => word.index >= span.start && word.index <= span.end)
    .map((word) => word.text)
    .join(" ");
}

/**
 * The turns after Fix text: the words under `span` give way to the words of
 * `text` (marks and flags dropped, since the host re-measures them), and the
 * words after shift to keep their indices running.
 */
export function replaceSpan(
  turns: readonly ScriptTurn[],
  span: ScriptSpan,
  text: string,
): ScriptTurn[] {
  const next = text.split(/\s+/).filter((word) => word !== "");
  const shift = next.length - (span.end - span.start + 1);
  const named = (index: number) => `episode:${index}`;
  return turns.map((turn) => ({
    ...turn,
    words: turn.words.flatMap((word): ScriptWord[] => {
      if (word.index < span.start) return [word];
      if (word.index > span.end) {
        const index = word.index + shift;
        return [{ ...word, index, key: named(index) }];
      }
      return word.index === span.start
        ? next.map((spoken, at) => ({
            index: span.start + at,
            key: named(span.start + at),
            text: spoken,
          }))
        : [];
    }),
  }));
}

const FILLER =
  "the room sounds smaller when we talk about it than when we are in it and that changes what we hear";

/**
 * `count` turns of about `size` words, alternating two speakers, with word
 * indices running on from 0. For scrolling, edge scroll and size stories.
 */
export function longScript(count: number, size = 24): ScriptTurn[] {
  const filler = FILLER.split(" ");
  let next = 0;
  return Array.from({ length: count }, (_, at) => {
    const from = next;
    const words: ScriptWord[] = Array.from({ length: size }, (_, w) => ({
      index: from + w,
      key: `episode:${from + w}`,
      text: filler[(at + w) % filler.length],
    }));
    next += size;
    const maya = at % 2 === 0;
    return {
      id: `long-${at}`,
      speakerId: maya ? "maya" : "anneke",
      speaker: maya ? MAYA : ANNEKE,
      time: `${String(Math.floor(at / 2) + 1).padStart(2, "0")}:${at % 2 === 0 ? "04" : "34"}`,
      pauseBefore: 1.2,
      words,
    };
  });
}

/** One turn of `size` words: the size a row of hours-long dictation reaches. */
export function hugeTurn(size: number): ScriptTurn[] {
  return longScript(1, size);
}

/** A Hebrew turn between two English ones, so lines run both ways. */
export const RTL_TURNS: readonly ScriptTurn[] = (() => {
  const hebrew = "שלום לכולם ברוכים הבאים להקלטה של היום על חדרים קטנים".split(
    " ",
  );
  const before = SCRIPT_TURNS[0].words.slice(0, 6);
  return [
    { ...SCRIPT_TURNS[0], words: before },
    {
      id: "he",
      speakerId: "anneke",
      speaker: ANNEKE,
      time: "12:19",
      pauseBefore: 1.4,
      words: hebrew.map((text, at) => ({
        index: 6 + at,
        key: `episode:${6 + at}`,
        text,
      })),
    },
    {
      id: "en",
      speakerId: "maya",
      speaker: MAYA,
      time: "12:30",
      pauseBefore: 1.4,
      words: ["Thanks", "for", "that."].map((text, at) => ({
        index: 6 + hebrew.length + at,
        key: `episode:${6 + hebrew.length + at}`,
        text,
      })),
    },
  ];
})();
