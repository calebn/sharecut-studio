import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ScriptPaneHandle } from "../../../system/ScriptPane";
import type { ScriptTurn } from "../../../system/scriptPieces";
import type { ScriptModel } from "./scriptModel";

/** Up to this many turns the pane gets them all, and never more are drawn at once: a widening that would pass it drops the far end. */
export const WINDOW_LIMIT = 150;
/** Turns kept either side of where the reader is. */
export const WINDOW_MARGIN = 40;
/** A keyboard move this close to the window's edge widens it. */
const EDGE = 3;
/** The body's scroll distance from an end that widens the window. */
const SCROLL_REACH = 600;

type Range = { lo: number; hi: number };

export type ScriptWindow = {
  /** The turns the pane draws. Word indices stay the episode's. */
  turns: readonly ScriptTurn[];
  /** Scroll to a word, moving the window to it first when the pane does not draw it. */
  scrollTo: (index: number, block?: ScrollLogicalPosition) => boolean;
  /** A caret or selection landed on this word: widen when it is near the window's edge. */
  reached: (index: number) => void;
};

/** Where the reader's eye sits in the body, so a change of window can put it back. */
type EyeMark = { turnId: string; offset: number };

/**
 * A window of turns the reader is in. It starts around the playhead (while it
 * is followed) or the top, and moves with the reader: a jump to a word the pane
 * lacks puts the window around that word, and the body's own scroll or a key
 * near an edge grows it on that side and drops turns from the far end, so it
 * never draws more than `WINDOW_LIMIT` turns. The pane draws every turn it
 * is given and does not tell the host when a key reaches its edge, so the host
 * learns of edges from the selection and caret and from the body's scroll.
 * A change the reader did not make with the scroll bar keeps the turn they were
 * looking at where it was.
 */
export function useScriptWindow(
  model: ScriptModel,
  pane: RefObject<ScriptPaneHandle | null>,
  host: RefObject<HTMLElement | null>,
  focus: {
    playKey: string;
    playing: readonly number[];
    playheadWord: number | undefined;
    following: boolean;
  },
): ScriptWindow {
  const total = model.turns.length;
  const windowed = total > WINDOW_LIMIT;
  const firsts = useMemo(
    () => model.turns.map((turn) => turn.words[0]?.index ?? -1),
    [model.turns],
  );
  const turnOf = useCallback(
    (index: number) => {
      let lo = 0;
      let hi = firsts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (firsts[mid] <= index) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    },
    [firsts],
  );

  const [view, setView] = useState<Range | null>(null);
  const liveWord = focus.following
    ? (focus.playing[0] ?? focus.playheadWord)
    : undefined;
  const anchor = useRef(0);
  if (liveWord !== undefined) anchor.current = liveWord;
  const start = anchor.current;
  const range = useMemo<Range>(() => {
    if (!windowed) return { lo: 0, hi: Math.max(total - 1, 0) };
    const base = view ?? around(turnOf(start), total);
    return clamp(base, total);
  }, [windowed, total, view, turnOf, start]);
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const turns = useMemo(
    () => (windowed ? model.turns.slice(range.lo, range.hi + 1) : model.turns),
    [windowed, model.turns, range],
  );

  const eye = useRef<EyeMark | null>(null);
  const bodyOf = useCallback(
    () => host.current?.querySelector<HTMLElement>(".sys-script-body") ?? null,
    [host],
  );
  const markEye = useCallback(() => {
    const body = bodyOf();
    if (!body) return;
    const top = body.getBoundingClientRect().top;
    for (const el of body.querySelectorAll<HTMLElement>("[data-turn-id]")) {
      const box = el.getBoundingClientRect();
      if (box.bottom > top) {
        eye.current = {
          turnId: el.dataset.turnId ?? "",
          offset: box.top - top,
        };
        return;
      }
    }
  }, [bodyOf]);

  /** Draw `next` (kept inside the cap) and report whether the drawn range changed. */
  const show = useCallback(
    (next: Range, keepEye: boolean): boolean => {
      const now = rangeRef.current;
      if (next.lo === now.lo && next.hi === now.hi) return false;
      if (keepEye) markEye();
      rangeRef.current = next;
      setView(next);
      return true;
    },
    [markEye],
  );

  const grow = useCallback(
    (side: "up" | "down", keepEye: boolean) => {
      if (!windowed) return;
      const now = rangeRef.current;
      show(
        side === "up"
          ? capFrom({ lo: now.lo - WINDOW_MARGIN, hi: now.hi }, total, "lo")
          : capFrom({ lo: now.lo, hi: now.hi + WINDOW_MARGIN }, total, "hi"),
        keepEye,
      );
    },
    [windowed, total, show],
  );

  const retry = useRef<{ index: number; block?: ScrollLogicalPosition } | null>(
    null,
  );
  const scrollTo = useCallback(
    (index: number, block?: ScrollLogicalPosition) => {
      retry.current = null;
      if (pane.current?.scrollToWord(index, block)) return true;
      if (!windowed) return false;
      const at = turnOf(index);
      const target = around(at, total);
      const now = rangeRef.current;
      // Its turn is drawn already, so the pane lacks the word itself: no window helps.
      if (now.lo <= at && at <= now.hi) return false;
      const near = target.lo <= now.hi + 1 && target.hi >= now.lo - 1;
      // A word beside the window joins it; a far one replaces it.
      const next = near
        ? capAround(
            {
              lo: Math.min(now.lo, target.lo),
              hi: Math.max(now.hi, target.hi),
            },
            at,
            total,
          )
        : target;
      // Only a change of window gives the retry something to find.
      if (show(next, false)) retry.current = { index, block };
      return false;
    },
    [pane, windowed, turnOf, total, show],
  );
  // Once per request: the new window is drawn, so the word can be found now.
  // A change of window the reader did not ask for keeps the turn they were on.
  const drawn = useRef("");
  useLayoutEffect(() => {
    const key = `${range.lo}:${range.hi}`;
    if (drawn.current === key) return;
    drawn.current = key;
    const again = retry.current;
    retry.current = null;
    if (again) {
      eye.current = null;
      pane.current?.scrollToWord(again.index, again.block);
      return;
    }
    const mark = eye.current;
    eye.current = null;
    const body = bodyOf();
    if (!mark || !body) return;
    const el = [...body.querySelectorAll<HTMLElement>("[data-turn-id]")].find(
      (candidate) => candidate.dataset.turnId === mark.turnId,
    );
    if (!el) return;
    const shift =
      el.getBoundingClientRect().top -
      body.getBoundingClientRect().top -
      mark.offset;
    if (shift !== 0) body.scrollTop += shift;
  }, [range.lo, range.hi, pane, bodyOf]);

  const reached = useCallback(
    (index: number) => {
      const at = turnOf(index);
      const now = rangeRef.current;
      if (at <= now.lo + EDGE) grow("up", true);
      else if (at >= now.hi - EDGE) grow("down", true);
    },
    [turnOf, grow],
  );

  // The body is not drawn while the pane loads, so it can be a new node when the
  // model is the same: look again after every commit and bind when it changed.
  const growing = useRef(grow);
  useLayoutEffect(() => {
    growing.current = grow;
  }, [grow]);
  const bound = useRef<{ body: HTMLElement; off: () => void } | null>(null);
  useEffect(() => {
    const body = windowed ? bodyOf() : null;
    if (bound.current?.body === body) return;
    bound.current?.off();
    bound.current = null;
    if (!body) return;
    const onScroll = () => {
      if (body.scrollTop < SCROLL_REACH) growing.current("up", true);
      if (
        body.scrollHeight - body.scrollTop - body.clientHeight <
        SCROLL_REACH
      ) {
        growing.current("down", true);
      }
    };
    body.addEventListener("scroll", onScroll, { passive: true });
    bound.current = {
      body,
      off: () => body.removeEventListener("scroll", onScroll),
    };
  });
  useEffect(
    () => () => {
      bound.current?.off();
      bound.current = null;
    },
    [],
  );

  // While the playhead is followed, the pane keeps up with it.
  const { playKey, following, playing } = focus;
  const followed = useRef<string | null>(null);
  useEffect(() => {
    const word = playing[0];
    if (!following || word === undefined) {
      followed.current = null;
      return;
    }
    if (followed.current === playKey) return;
    followed.current = playKey;
    scrollTo(word, "nearest");
  }, [playKey, following, playing, scrollTo]);

  return { turns, scrollTo, reached };
}

function clamp(range: Range, total: number): Range {
  const hi = Math.min(Math.max(range.hi, 0), Math.max(total - 1, 0));
  return { lo: Math.min(Math.max(range.lo, 0), hi), hi };
}

/** The turns the reader keeps either side of `turn`. */
function around(turn: number, total: number): Range {
  return clamp({ lo: turn - WINDOW_MARGIN, hi: turn + WINDOW_MARGIN }, total);
}

/** `range` grown past the cap loses its far end: the one opposite `keep`. */
function capFrom(range: Range, total: number, keep: "lo" | "hi"): Range {
  const next = clamp(range, total);
  if (next.hi - next.lo + 1 <= WINDOW_LIMIT) return next;
  return keep === "lo"
    ? { lo: next.lo, hi: next.lo + WINDOW_LIMIT - 1 }
    : { lo: next.hi - WINDOW_LIMIT + 1, hi: next.hi };
}

/** `range` grown past the cap is cut to a span centred on `turn`. */
function capAround(range: Range, turn: number, total: number): Range {
  const next = clamp(range, total);
  if (next.hi - next.lo + 1 <= WINDOW_LIMIT) return next;
  const lo = Math.min(
    Math.max(next.lo, turn - (WINDOW_LIMIT >> 1)),
    next.hi - WINDOW_LIMIT + 1,
  );
  return { lo, hi: lo + WINDOW_LIMIT - 1 };
}
