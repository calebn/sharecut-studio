import {
  pieceEnd,
  pieceStart,
  type ScriptPiece,
  type ScriptSelection,
  type ScriptSpan,
  type ScriptStop,
  type WordsSelection,
} from "./scriptPieces";

export type NavKey = "ArrowLeft" | "ArrowRight" | "Home" | "End";

export const isNavKey = (key: string): key is NavKey =>
  key === "ArrowLeft" ||
  key === "ArrowRight" ||
  key === "Home" ||
  key === "End";

export type Navigation = {
  /** The place that takes focus, as a position in `stops`. */
  to: number;
  /** A plain move: the caret now sits before this word. */
  caret?: number;
  /** A Shift move: the selection now runs from its anchor to this head. */
  selection?: WordsSelection;
};

/** The words a selection covers, or null when it is a cut, a suggestion or nothing. */
export function spanOf(
  selection: ScriptSelection | null | undefined,
): ScriptSpan | null {
  if (selection?.kind !== "words") return null;
  return {
    start: Math.min(selection.anchor, selection.head),
    end: Math.max(selection.anchor, selection.head),
  };
}

/**
 * The selection a Shift move or a Shift-click makes: the anchor stays and the
 * head lands on the far edge of the place it reaches in the direction of
 * travel, so a pill or a suggested run is taken whole. A head that falls on
 * the anchor's own place stays on the anchor, so the way back shrinks.
 */
export function extendTo(
  anchor: number,
  reached: Pick<ScriptStop, "start" | "end">,
): WordsSelection {
  const head =
    reached.end < anchor
      ? reached.start
      : reached.start > anchor
        ? reached.end
        : anchor;
  return { kind: "words", anchor, head };
}

/**
 * Where a navigation key takes the keyboard. A plain key moves the caret to
 * the place it reaches. With Shift the selection grows from its real anchor,
 * which is where the move began when nothing was selected. Null when the key
 * changes nothing.
 */
export function navigate(
  stops: readonly ScriptStop[],
  at: number,
  key: NavKey,
  shift: boolean,
  selection: ScriptSelection | null | undefined,
): Navigation | null {
  if (stops.length === 0 || at < 0 || at >= stops.length) return null;
  const forward = key === "ArrowRight" || key === "End";
  const to = (() => {
    switch (key) {
      case "ArrowRight":
        return Math.min(stops.length - 1, at + 1);
      case "ArrowLeft":
        return Math.max(0, at - 1);
      case "Home":
        return 0;
      case "End":
        return stops.length - 1;
    }
  })();
  if (!shift) {
    return to === at ? null : { to, caret: stops[to].start };
  }
  const anchor =
    selection?.kind === "words"
      ? selection.anchor
      : forward
        ? stops[at].start
        : stops[at].end;
  const next = extendTo(anchor, stops[to]);
  if (
    selection?.kind === "words" &&
    selection.anchor === next.anchor &&
    selection.head === next.head
  ) {
    return null;
  }
  return { to, selection: next };
}

/** What a polite live region says when the selection changes. Empty for nothing selected. */
export function selectionSummary(
  pieces: readonly ScriptPiece[],
  selection: ScriptSelection | null | undefined,
): string {
  if (!selection) return "";
  if (selection.kind === "cut") {
    const cut = pieces.find(
      (piece) => piece.kind === "cut" && piece.id === selection.id,
    );
    return cut?.kind === "cut" ? `Cut selected, ${cut.removed} removed` : "";
  }
  if (selection.kind === "suggestion") {
    const run = pieces.find(
      (piece) => piece.kind === "suggestion" && piece.id === selection.id,
    );
    return run?.kind === "suggestion"
      ? `Suggested cut selected: ${run.text}`
      : "";
  }
  const span = spanOf(selection);
  if (!span) return "";
  const words = pieces.flatMap((piece) => {
    if (pieceEnd(piece) < span.start || pieceStart(piece) > span.end) return [];
    switch (piece.kind) {
      case "word":
        return [piece.word.text];
      case "muted":
        return piece.words
          .filter((w) => w.index >= span.start && w.index <= span.end)
          .map((w) => w.text);
      case "cut":
        return [`cut ${piece.words}`];
      case "suggestion":
        return [piece.text];
      case "editing":
        return [];
    }
  });
  const shown = words.length > 12 ? [...words.slice(0, 12), "..."] : words;
  const count = span.end - span.start + 1;
  return `${count} ${count === 1 ? "word" : "words"} selected: ${shown.join(" ")}`;
}
