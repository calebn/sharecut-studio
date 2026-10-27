import type { PersonData } from "./Person";
import { formatSeconds } from "./seconds";

export type ScriptWordState = "cut" | "suggested" | "muted";

export type ScriptWord = {
  /** Position in the transcript. Selections, carets and callbacks use it. */
  index: number;
  /** The word with its punctuation: "Hello,". */
  text: string;
  state?: ScriptWordState;
  /** Seconds of speech. A cut run shows the sum. */
  length: number;
  lowConfidence?: boolean;
  /** Just brought back: a static highlight that clears on the next action. */
  restored?: boolean;
};

export type ScriptTurn = {
  id: string;
  speaker: PersonData;
  /** Where the turn starts, "12:04". */
  time: string;
  /** Seconds since the previous turn ended. Under 2 s and the same speaker, the name is not repeated. */
  pauseBefore?: number;
  words: readonly ScriptWord[];
};

/** Words `start` to `end`, both included. */
export type ScriptSpan = { start: number; end: number };

/** A caret sits before word `before`. Without a person it is your own. */
export type ScriptCaret = { before: number; person?: PersonData };

export type ScriptStatus =
  | { kind: "ready" }
  | { kind: "loading"; elapsedMs?: number; onRetry?: () => void }
  | { kind: "empty"; onTranscribe: () => void }
  | {
      kind: "transcribing";
      /** 0 to 1. */
      progress: number;
      /** The time still to come, "12:00 to 52:10". */
      notYet?: string;
    }
  | { kind: "outOfDate"; onUpdate: () => void };

export type ScriptPiece =
  | { kind: "word"; word: ScriptWord }
  | {
      kind: "cut";
      start: number;
      end: number;
      removed: string;
      words: string;
    }
  | { kind: "suggestion"; start: number; end: number; text: string }
  | { kind: "muted"; words: readonly ScriptWord[] };

export function pieceStart(piece: ScriptPiece): number {
  switch (piece.kind) {
    case "word":
      return piece.word.index;
    case "muted":
      return piece.words[0].index;
    default:
      return piece.start;
  }
}

export function pieceEnd(piece: ScriptPiece): number {
  switch (piece.kind) {
    case "word":
      return piece.word.index;
    case "muted":
      return piece.words[piece.words.length - 1].index;
    default:
      return piece.end;
  }
}

/**
 * Runs of one state become one piece: cut words collapse into a pill unless
 * their text shows, suggested words into one hatched run, muted words into a
 * group behind one glyph.
 */
export function piecesOf(
  words: readonly ScriptWord[],
  showCutText: boolean,
): ScriptPiece[] {
  const pieces: ScriptPiece[] = [];
  let at = 0;
  while (at < words.length) {
    const word = words[at];
    const state = word.state === "cut" && showCutText ? undefined : word.state;
    let next = at + 1;
    while (
      state !== undefined &&
      next < words.length &&
      words[next].state === word.state
    ) {
      next += 1;
    }
    const run = words.slice(at, next);
    const text = run.map((w) => w.text).join(" ");
    const span = { start: run[0].index, end: run[run.length - 1].index };
    if (state === "cut") {
      const seconds = run.reduce((sum, w) => sum + w.length, 0);
      pieces.push({
        kind: "cut",
        ...span,
        removed: formatSeconds(seconds),
        words: text,
      });
    } else if (state === "suggested") {
      pieces.push({ kind: "suggestion", ...span, text });
    } else if (state === "muted") {
      pieces.push({ kind: "muted", words: run });
    } else {
      pieces.push({ kind: "word", word });
    }
    at = state === undefined ? at + 1 : next;
  }
  return pieces;
}

/** Whether the turn repeats the previous speaker closely enough to drop the name. */
export function continuesSpeaker(
  turn: ScriptTurn,
  previous: ScriptTurn | undefined,
): boolean {
  return (
    previous !== undefined &&
    previous.speaker.name === turn.speaker.name &&
    turn.pauseBefore !== undefined &&
    turn.pauseBefore < 2
  );
}
