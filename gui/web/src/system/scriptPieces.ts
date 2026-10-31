import type { PersonData } from "./Person";
import { formatSeconds } from "./seconds";

/**
 * What an edit has done to a word. A cut and a suggestion carry the id of the
 * edit, so two neighbouring ones stay two. A cut carries the seconds it
 * removed, which the host measures (pauses inside a cut count), so the pill
 * never sums word lengths.
 */
export type ScriptMark =
  | { kind: "cut"; id: string; seconds: number }
  | { kind: "suggested"; id: string }
  | { kind: "muted" };

export type ScriptWord = {
  /** Position in the window of turns the pane was given. Selections, carets and callbacks use it. */
  index: number;
  /**
   * The host's stable name for the word, for example "trackId:sourceId:wordIndex".
   * The pane never reads it. It lets the host map an index back to the store.
   */
  key?: string;
  /** The word with its punctuation: "Hello,". */
  text: string;
  mark?: ScriptMark;
  lowConfidence?: boolean;
  /** Just brought back: a static highlight that clears on the next action. */
  restored?: boolean;
  /** Where another person's cursor or selection finds this word (a `data-presence-anchor` id). */
  anchor?: string;
};

export type ScriptTurn = {
  id: string;
  /** Who speaks. Two turns by one speaker id merge; names can repeat. */
  speakerId: string;
  speaker: PersonData;
  /** Where the turn starts, "12:04". */
  time: string;
  /** Seconds since the previous turn ended, measured by the host. Under 2 s and the same speaker id, the name is not repeated. */
  pauseBefore?: number;
  words: readonly ScriptWord[];
};

/** Words `start` to `end`, both included. */
export type ScriptSpan = { start: number; end: number };

/**
 * What is selected. One thing at a time: a run of words, one cut or one
 * suggestion. `anchor` stays put and `head` moves, so Shift+Left after
 * Shift+Right shrinks instead of flipping.
 */
export type ScriptSelection =
  | { kind: "words"; anchor: number; head: number }
  | { kind: "cut"; id: string }
  | { kind: "suggestion"; id: string };

export type WordsSelection = Extract<ScriptSelection, { kind: "words" }>;

/** A caret sits before word `before`. Without a person it is your own. */
export type ScriptCaret = { before: number; person?: PersonData };

export type ScriptStatus =
  | { kind: "ready" }
  | { kind: "loading"; elapsedMs?: number; onRetry?: () => void }
  /** `onTranscribe` is left out for a viewer who may not start one. */
  | { kind: "empty"; onTranscribe?: () => void }
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
      id: string;
      start: number;
      end: number;
      removed: string;
      words: string;
      /** The cut began in an earlier turn: this pill is its rest and does not repeat the length. */
      continued?: boolean;
      /** The cut runs on into a later turn. Only the pill where it begins shows the length. */
      continues?: boolean;
    }
  | {
      kind: "suggestion";
      id: string;
      start: number;
      end: number;
      text: string;
    }
  | { kind: "muted"; words: readonly ScriptWord[] }
  | { kind: "editing"; start: number; end: number };

/** One place the keyboard can stop: a word, a cut pill or a suggested run. */
export type ScriptStop = {
  kind: "word" | "cut" | "suggestion";
  start: number;
  end: number;
  id?: string;
};

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

const sameMark = (a: ScriptMark | undefined, b: ScriptMark | undefined) =>
  a !== undefined &&
  b !== undefined &&
  a.kind === b.kind &&
  (a.kind === "muted" || a.id === (b as typeof a).id);

/**
 * Runs of one mark become one piece: cut words collapse into a pill unless
 * their text shows, suggested words into one hatched run, muted words into a
 * group behind one glyph. A run ends where the mark's id changes.
 */
export function piecesOf(
  words: readonly ScriptWord[],
  showCutText: boolean,
): ScriptPiece[] {
  const pieces: ScriptPiece[] = [];
  let at = 0;
  while (at < words.length) {
    const word = words[at];
    const mark =
      word.mark?.kind === "cut" && showCutText ? undefined : word.mark;
    let next = at + 1;
    while (
      mark !== undefined &&
      next < words.length &&
      sameMark(mark, words[next].mark)
    ) {
      next += 1;
    }
    const run = words.slice(at, next);
    const text = run.map((w) => w.text).join(" ");
    const span = { start: run[0].index, end: run[run.length - 1].index };
    if (mark?.kind === "cut") {
      pieces.push({
        kind: "cut",
        id: mark.id,
        ...span,
        removed: formatSeconds(mark.seconds),
        words: text,
      });
    } else if (mark?.kind === "suggested") {
      pieces.push({ kind: "suggestion", id: mark.id, ...span, text });
    } else if (mark?.kind === "muted") {
      pieces.push({ kind: "muted", words: run });
    } else {
      pieces.push({ kind: "word", word });
    }
    at = mark === undefined ? at + 1 : next;
  }
  return pieces;
}

/**
 * One cut that crosses a turn boundary is one piece in each turn it touches.
 * Marks the later pieces `continued` and the earlier ones `continues`, so the
 * length the host measured is shown once, on the pill where the cut begins.
 */
export function linkCuts(byTurn: ScriptPiece[][]): ScriptPiece[][] {
  const last = new Map<string, number>();
  byTurn.forEach((pieces, turn) => {
    for (const piece of pieces) {
      if (piece.kind === "cut") last.set(piece.id, turn);
    }
  });
  const seen = new Set<string>();
  return byTurn.map((pieces, turn) => {
    const linked = pieces.map((piece): ScriptPiece => {
      if (piece.kind !== "cut") return piece;
      const continued = seen.has(piece.id) ? true : undefined;
      const continues = (last.get(piece.id) ?? turn) > turn ? true : undefined;
      seen.add(piece.id);
      return continued || continues
        ? { ...piece, continued, continues }
        : piece;
    });
    return linked.some((piece, at) => piece !== pieces[at]) ? linked : pieces;
  });
}

/**
 * Pieces with every piece the editing span touches replaced by one slot for
 * the Fix text field. The same array comes back when nothing is touched.
 */
export function withEditing(
  pieces: ScriptPiece[],
  editing: ScriptSpan | null | undefined,
): ScriptPiece[] {
  if (!editing) return pieces;
  const touched = pieces.filter(
    (piece) =>
      pieceStart(piece) <= editing.end && pieceEnd(piece) >= editing.start,
  );
  if (touched.length === 0) return pieces;
  const slot: ScriptPiece = {
    kind: "editing",
    start: pieceStart(touched[0]),
    end: pieceEnd(touched[touched.length - 1]),
  };
  const first = pieces.indexOf(touched[0]);
  return [
    ...pieces.slice(0, first),
    slot,
    ...pieces.slice(first + touched.length),
  ];
}

/** The keyboard's places, in reading order. A muted word is a place; the field being edited is not. */
export function stopsOf(pieces: readonly ScriptPiece[]): ScriptStop[] {
  return pieces.flatMap((piece): ScriptStop[] => {
    switch (piece.kind) {
      case "word":
        return [
          { kind: "word", start: piece.word.index, end: piece.word.index },
        ];
      case "muted":
        return piece.words.map((word) => ({
          kind: "word",
          start: word.index,
          end: word.index,
        }));
      case "cut":
      case "suggestion":
        return [
          {
            kind: piece.kind,
            start: piece.start,
            end: piece.end,
            id: piece.id,
          },
        ];
      case "editing":
        return [];
    }
  });
}

/** The place that holds word `index`, if the pane shows it. */
export function stopContaining(
  stops: readonly ScriptStop[],
  index: number | undefined,
): ScriptStop | undefined {
  if (index === undefined) return undefined;
  return stops.find((stop) => stop.start <= index && index <= stop.end);
}

/** Whether the turn repeats the previous speaker closely enough to drop the name. */
export function continuesSpeaker(
  turn: ScriptTurn,
  previous: ScriptTurn | undefined,
): boolean {
  return (
    previous !== undefined &&
    previous.speakerId === turn.speakerId &&
    turn.pauseBefore !== undefined &&
    turn.pauseBefore < 2
  );
}

export type WordFound = "match" | "current";

/**
 * The name a screen reader gives a word whose state the eye reads from style.
 * A plain word has none, so its text is its name. Playing is `aria-current`.
 * A cut word only reaches here struck, because a collapsed cut is a pill.
 */
export function wordLabel(
  word: ScriptWord,
  state: { selected: boolean; found?: WordFound },
): string | undefined {
  const notes = [
    word.mark?.kind === "cut" ? "cut" : null,
    word.mark?.kind === "muted" ? "muted" : null,
    word.lowConfidence ? "unsure" : null,
    word.restored ? "restored" : null,
    state.found === "current" ? "current match" : null,
    state.found === "match" ? "match" : null,
    state.selected ? "selected" : null,
  ].filter((note) => note !== null);
  return notes.length > 0 ? `${word.text} (${notes.join(", ")})` : undefined;
}
