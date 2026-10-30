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

/** Up to this many turns the pane gets them all. */
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
  /** Scroll to a word, widening the window first when the pane does not draw it. */
  scrollTo: (index: number, block?: ScrollLogicalPosition) => boolean;
  /** A caret or selection landed on this word: widen when it is near the window's edge. */
  reached: (index: number) => void;
};

/**
 * A window of turns around the playhead (while it is followed), the
 * selection, or wherever the reader has been taken. The pane draws every turn
 * it is given and does not tell the host when a key reaches its edge, so the
 * host widens on a caret or selection near the edge, on the body's own scroll
 * near an end, and when `scrollTo` lands on a word the pane lacks.
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
  selectionHead: number | undefined,
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

  const [widened, setWidened] = useState<Range | null>(null);
  const centerWord =
    (focus.following ? (focus.playing[0] ?? focus.playheadWord) : undefined) ??
    selectionHead ??
    0;
  const center = turnOf(centerWord);
  const range = useMemo<Range>(() => {
    if (!windowed) return { lo: 0, hi: Math.max(total - 1, 0) };
    let lo = Math.max(0, center - WINDOW_MARGIN);
    let hi = Math.min(total - 1, center + WINDOW_MARGIN);
    // A widening only counts while the reader is still near it.
    if (
      widened &&
      center >= widened.lo - WINDOW_MARGIN &&
      center <= widened.hi + WINDOW_MARGIN
    ) {
      lo = Math.min(lo, widened.lo);
      hi = Math.max(hi, widened.hi);
    }
    return { lo, hi };
  }, [windowed, total, center, widened]);
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const turns = useMemo(
    () => (windowed ? model.turns.slice(range.lo, range.hi + 1) : model.turns),
    [windowed, model.turns, range],
  );

  const widen = useCallback(
    (lo: number, hi: number) => {
      if (!windowed) return;
      const now = rangeRef.current;
      const next = {
        lo: Math.max(0, Math.min(now.lo, lo)),
        hi: Math.min(total - 1, Math.max(now.hi, hi)),
      };
      if (next.lo !== now.lo || next.hi !== now.hi) setWidened(next);
    },
    [windowed, total],
  );

  const retry = useRef<{ index: number; block?: ScrollLogicalPosition } | null>(
    null,
  );
  const scrollTo = useCallback(
    (index: number, block?: ScrollLogicalPosition) => {
      if (pane.current?.scrollToWord(index, block)) return true;
      retry.current = { index, block };
      const at = turnOf(index);
      widen(at - WINDOW_MARGIN, at + WINDOW_MARGIN);
      return false;
    },
    [pane, turnOf, widen],
  );
  // Once per request: the widened window is drawn, so the word can be found now.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the drawn range changes
  useLayoutEffect(() => {
    const again = retry.current;
    retry.current = null;
    if (again) pane.current?.scrollToWord(again.index, again.block);
  }, [range.lo, range.hi, pane]);

  const reached = useCallback(
    (index: number) => {
      const at = turnOf(index);
      const now = rangeRef.current;
      if (at <= now.lo + EDGE) widen(now.lo - WINDOW_MARGIN, now.hi);
      if (at >= now.hi - EDGE) widen(now.lo, now.hi + WINDOW_MARGIN);
    },
    [turnOf, widen],
  );

  useEffect(() => {
    if (!windowed) return;
    const body = host.current?.querySelector<HTMLElement>(".sys-script-body");
    if (!body) return;
    const onScroll = () => {
      const now = rangeRef.current;
      if (body.scrollTop < SCROLL_REACH) {
        widen(now.lo - WINDOW_MARGIN, now.hi);
      }
      if (
        body.scrollHeight - body.scrollTop - body.clientHeight <
        SCROLL_REACH
      ) {
        widen(now.lo, now.hi + WINDOW_MARGIN);
      }
    };
    body.addEventListener("scroll", onScroll, { passive: true });
    return () => body.removeEventListener("scroll", onScroll);
  });

  // While the playhead is followed, the pane keeps up with it.
  const { playKey, following, playing } = focus;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new highlight is the trigger
  useEffect(() => {
    const word = playing[0];
    if (following && word !== undefined) scrollTo(word, "nearest");
  }, [playKey, following]);

  return { turns, scrollTo, reached };
}
