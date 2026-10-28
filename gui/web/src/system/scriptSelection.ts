import {
  pieceEnd,
  pieceStart,
  piecesOf,
  type ScriptPiece,
  type ScriptSelection,
  type ScriptSpan,
  type ScriptStop,
  type ScriptTurn,
  type WordsSelection,
} from "./scriptPieces";

type NavKey =
  | "ArrowLeft"
  | "ArrowRight"
  | "ArrowUp"
  | "ArrowDown"
  | "Home"
  | "End";

export const isNavKey = (key: string): key is NavKey =>
  key === "ArrowLeft" ||
  key === "ArrowRight" ||
  key === "ArrowUp" ||
  key === "ArrowDown" ||
  key === "Home" ||
  key === "End";

export const isLeftKey = (key: string) => key === "ArrowLeft";

export const isVerticalKey = (key: string) =>
  key === "ArrowUp" || key === "ArrowDown";

/** One place back (Left) or on (Right); the other keys have no horizontal step. */
export function horizontalStep(key: string): -1 | 1 | null {
  return key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : null;
}

/** Where one place sits on screen, in any one coordinate space. */
export type StopRect = {
  top: number;
  bottom: number;
  left: number;
  right: number;
};

/**
 * Where one place sits: a rect for each line it occupies, in reading order.
 * A suggested run that wraps has several.
 */
export type StopRects = readonly StopRect[];

/** The screen position of every stop (null when it is not drawn) and the column a vertical run of moves keeps. */
export type Vertical = {
  rects: readonly (StopRects | null)[];
  goalX: number;
};

/** An edge of a words selection. */
export type HandleEdge = "start" | "end";

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

const centreY = (r: StopRect) => (r.top + r.bottom) / 2;

/**
 * The place one line up or down that sits nearest the column `goalX`, leaving
 * from the first line of a wrapped place going up and its last going down.
 * Places whose centres lie within half a place's height of each other share a
 * line, and a wrapped place can be reached on any of its lines. Null when
 * there is no line in that direction.
 */
export function verticalStop(
  rects: readonly (StopRects | null)[],
  at: number,
  direction: -1 | 1,
  goalX: number,
): number | null {
  const lines = rects[at];
  const here = lines && (direction > 0 ? lines[lines.length - 1] : lines[0]);
  if (!here) return null;
  const tolerance = (here.bottom - here.top) / 2;
  const reachable = rects.flatMap((fragments, index) =>
    index === at || !fragments
      ? []
      : fragments
          .filter(
            (rect) => direction * (centreY(rect) - centreY(here)) > tolerance,
          )
          .map((rect) => ({ rect, index })),
  );
  if (reachable.length === 0) return null;
  const nearest = reachable.reduce((best, line) =>
    direction * centreY(line.rect) < direction * centreY(best.rect)
      ? line
      : best,
  );
  const sameLine = reachable.filter(
    ({ rect }) => Math.abs(centreY(rect) - centreY(nearest.rect)) <= tolerance,
  );
  const gap = ({ rect }: (typeof sameLine)[number]) =>
    goalX < rect.left
      ? rect.left - goalX
      : goalX > rect.right
        ? goalX - rect.right
        : 0;
  return sameLine.reduce((best, line) => (gap(line) < gap(best) ? line : best))
    .index;
}

/**
 * The place nearest a point: first by distance from its line, then along the
 * line, over every line a wrapped place occupies. Null when nothing is drawn.
 */
export function nearestStop(
  rects: readonly (StopRects | null)[],
  x: number,
  y: number,
): number | null {
  const outside = (low: number, high: number, at: number) =>
    at < low ? low - at : at > high ? at - high : 0;
  const scored = rects.flatMap((fragments, index) =>
    (fragments ?? []).map((rect) => ({
      index,
      dy: outside(rect.top, rect.bottom, y),
      dx: outside(rect.left, rect.right, x),
    })),
  );
  if (scored.length === 0) return null;
  return scored.reduce((best, item) =>
    item.dy < best.dy || (item.dy === best.dy && item.dx < best.dx)
      ? item
      : best,
  ).index;
}

/**
 * Where a navigation key takes the keyboard. A plain key moves the caret to
 * the place it reaches. With Shift the selection grows from its real anchor,
 * which is where the move began when nothing was selected. Up and Down need
 * `vertical`, the stops' screen positions. Null when the key changes nothing.
 */
export function navigate(
  stops: readonly ScriptStop[],
  at: number,
  key: NavKey,
  shift: boolean,
  selection: ScriptSelection | null | undefined,
  vertical?: Vertical,
): Navigation | null {
  if (stops.length === 0 || at < 0 || at >= stops.length) return null;
  const forward = key === "ArrowRight" || key === "End" || key === "ArrowDown";
  const to = (() => {
    switch (key) {
      case "ArrowRight":
        return Math.min(stops.length - 1, at + 1);
      case "ArrowLeft":
        return Math.max(0, at - 1);
      case "ArrowUp":
      case "ArrowDown":
        return vertical
          ? verticalStop(
              vertical.rects,
              at,
              key === "ArrowDown" ? 1 : -1,
              vertical.goalX,
            )
          : null;
      case "Home":
        return 0;
      case "End":
        return stops.length - 1;
    }
  })();
  if (to === null) return null;
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

const positionOf = (stops: readonly ScriptStop[], word: number) =>
  stops.findIndex((stop) => stop.start <= word && word <= stop.end);

/**
 * A words selection with one edge moved onto `target`. The edges never cross:
 * the start stops on the last place and the end on the first. The direction
 * of the selection, anchor before head or after, is kept. Null when nothing
 * changes or the selection is not a run of words.
 */
export function dragEdge(
  stops: readonly ScriptStop[],
  selection: ScriptSelection | null | undefined,
  edge: HandleEdge,
  target: Pick<ScriptStop, "start" | "end">,
): WordsSelection | null {
  const span = spanOf(selection);
  if (selection?.kind !== "words" || !span) return null;
  const last = stops[positionOf(stops, span.end)];
  const first = stops[positionOf(stops, span.start)];
  const start =
    edge === "start"
      ? Math.min(target.start, last?.start ?? span.end)
      : span.start;
  const end =
    edge === "end" ? Math.max(target.end, first?.end ?? span.start) : span.end;
  if (start === span.start && end === span.end) return null;
  return selection.anchor <= selection.head
    ? { kind: "words", anchor: start, head: end }
    : { kind: "words", anchor: end, head: start };
}

/** `dragEdge` onto the place a step away from the edge's own place. */
export function stepEdge(
  stops: readonly ScriptStop[],
  selection: ScriptSelection | null | undefined,
  edge: HandleEdge,
  step: -1 | 1,
): WordsSelection | null {
  const span = spanOf(selection);
  if (!span || stops.length === 0) return null;
  const at = positionOf(stops, edge === "start" ? span.start : span.end);
  if (at < 0) return null;
  const to = Math.min(stops.length - 1, Math.max(0, at + step));
  return dragEdge(stops, selection, edge, stops[to]);
}

export type MarginControl = "speaker" | "time";

type MarginMove =
  | { kind: "control"; at: number }
  | { kind: "text" }
  | { kind: "before" };

/**
 * A key pressed on a turn's margin controls. Up and Down walk the controls,
 * Right goes back into the turn's words and Left leaves for the turn before.
 */
export function marginStep(
  controls: readonly MarginControl[],
  at: number,
  key: string,
): MarginMove | null {
  switch (key) {
    case "ArrowDown":
      return at + 1 < controls.length ? { kind: "control", at: at + 1 } : null;
    case "ArrowUp":
      return at > 0 ? { kind: "control", at: at - 1 } : null;
    case "ArrowRight":
      return { kind: "text" };
    case "ArrowLeft":
      return { kind: "before" };
    default:
      return null;
  }
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

/**
 * One track's share of a words selection. A span that crosses a speaker
 * change covers each speaker's words on that speaker's track, so the host
 * writes one store selection per entry. `startIndex` and `endIndex` are the
 * pane's window indices of that track's first and last word inside the span;
 * `first` and `last` are those words' `key`s, which the host maps back to
 * `trackId:sourceId:wordIndex`. A track's words inside a span are contiguous
 * on that track, even when another speaker's turn sits between two of its
 * turns. Cut, suggested and muted words are counted: the pane's drag takes a
 * pill or a run whole, and a cut word is still a word of the track.
 */
export type ScriptTrackSpan = {
  speakerId: string;
  startIndex: number;
  endIndex: number;
  first: string | undefined;
  last: string | undefined;
  /** Turns the track's words in the span sit in, in reading order. */
  turnIds: readonly string[];
};

export function trackSpans(
  turns: readonly ScriptTurn[],
  span: ScriptSpan | null,
): ScriptTrackSpan[] {
  if (!span) return [];
  const bySpeaker = new Map<string, ScriptTrackSpan & { turnIds: string[] }>();
  for (const turn of turns) {
    for (const word of turn.words) {
      if (word.index < span.start || word.index > span.end) continue;
      const found = bySpeaker.get(turn.speakerId);
      if (!found) {
        bySpeaker.set(turn.speakerId, {
          speakerId: turn.speakerId,
          startIndex: word.index,
          endIndex: word.index,
          first: word.key,
          last: word.key,
          turnIds: [turn.id],
        });
        continue;
      }
      found.endIndex = word.index;
      found.last = word.key;
      if (found.turnIds[found.turnIds.length - 1] !== turn.id) {
        found.turnIds.push(turn.id);
      }
    }
  }
  return [...bySpeaker.values()];
}

/**
 * What a copy of the selection puts on the clipboard: the words as the pane
 * shows them. A collapsed cut is a pill and gives nothing; with the cut text
 * showing, its struck words are text and are copied. A turn is a line.
 * Empty for a cut, a suggestion or nothing selected.
 */
export function selectionText(
  turns: readonly ScriptTurn[],
  selection: ScriptSelection | null | undefined,
  showCutText: boolean,
): string {
  const span = spanOf(selection);
  if (!span) return "";
  return turns
    .map((turn) =>
      piecesOf(turn.words, showCutText)
        .flatMap((piece) => {
          if (pieceEnd(piece) < span.start || pieceStart(piece) > span.end) {
            return [];
          }
          switch (piece.kind) {
            case "word":
              return [piece.word.text];
            case "muted":
              return piece.words
                .filter((w) => w.index >= span.start && w.index <= span.end)
                .map((w) => w.text);
            case "suggestion":
              return [piece.text];
            default:
              return [];
          }
        })
        .join(" "),
    )
    .filter((line) => line !== "")
    .join("\n");
}
