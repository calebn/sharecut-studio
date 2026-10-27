import {
  pieceEnd,
  pieceStart,
  type ScriptPiece,
  type ScriptSelection,
  type ScriptSpan,
  type ScriptStop,
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

/** The screen position of every stop (null when it is not drawn) and the column a vertical run of moves keeps. */
export type Vertical = {
  rects: readonly (StopRect | null)[];
  goalX: number;
};

/** An edge of a words selection, and how a key or a drag moves it. */
export type HandleEdge = "start" | "end";
export type HandleStep = -1 | 1 | "first" | "last";

/** The step a key makes on a selection handle, read as a slider: forward and up are one place on. */
export function handleStep(key: string): HandleStep | null {
  switch (key) {
    case "ArrowRight":
    case "ArrowUp":
      return 1;
    case "ArrowLeft":
    case "ArrowDown":
      return -1;
    case "Home":
      return "first";
    case "End":
      return "last";
    default:
      return null;
  }
}

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
 * The place one line up or down that sits nearest the column `goalX`. Places
 * whose centres lie within half a place's height of each other share a line.
 * Null when there is no line in that direction.
 */
export function verticalStop(
  rects: readonly (StopRect | null)[],
  at: number,
  direction: -1 | 1,
  goalX: number,
): number | null {
  const here = rects[at];
  if (!here) return null;
  const tolerance = (here.bottom - here.top) / 2;
  const lines = rects.flatMap((rect, index) =>
    rect && direction * (centreY(rect) - centreY(here)) > tolerance
      ? [{ rect, index }]
      : [],
  );
  if (lines.length === 0) return null;
  const nearest = lines.reduce((best, line) =>
    direction * centreY(line.rect) < direction * centreY(best.rect)
      ? line
      : best,
  );
  const sameLine = lines.filter(
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

/** The place nearest a point: first by distance from its line, then along the line. Null when nothing is drawn. */
export function nearestStop(
  rects: readonly (StopRect | null)[],
  x: number,
  y: number,
): number | null {
  const outside = (low: number, high: number, at: number) =>
    at < low ? low - at : at > high ? at - high : 0;
  const scored = rects.flatMap((rect, index) =>
    rect
      ? [
          {
            index,
            dy: outside(rect.top, rect.bottom, y),
            dx: outside(rect.left, rect.right, x),
          },
        ]
      : [],
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

/** `dragEdge` onto the place a step away from the edge's own place, or the first or last place. */
export function stepEdge(
  stops: readonly ScriptStop[],
  selection: ScriptSelection | null | undefined,
  edge: HandleEdge,
  step: HandleStep,
): WordsSelection | null {
  const span = spanOf(selection);
  if (!span || stops.length === 0) return null;
  const at = positionOf(stops, edge === "start" ? span.start : span.end);
  if (at < 0) return null;
  const to =
    step === "first"
      ? 0
      : step === "last"
        ? stops.length - 1
        : Math.min(stops.length - 1, Math.max(0, at + step));
  return dragEdge(stops, selection, edge, stops[to]);
}

/** Where an edge sits among the stops, counted from 1; 0 when the selection is not a run of drawn words. */
export function edgePosition(
  stops: readonly ScriptStop[],
  selection: ScriptSelection | null | undefined,
  edge: HandleEdge,
): number {
  const span = spanOf(selection);
  return span
    ? positionOf(stops, edge === "start" ? span.start : span.end) + 1
    : 0;
}

export type MarginControl = "speaker" | "time";

export type MarginMove =
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
