import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  LONG_PRESS_MS,
  TOUCH_SLOP_PX,
  withinGhostClick,
} from "../hooks/gestureConstants";
import {
  spanBetween,
  type WordSpan,
  type WordTarget,
  wordAtPoint,
} from "./rangeSelect";

const EDGE_BAND_PX = 56;
const EDGE_STEP_PX = 14;

export type WordRangeDraft = WordSpan & { trackId: string };

type Press = {
  pointerId: number;
  anchor: WordTarget;
  x: number;
  y: number;
  /** The hold elapsed with the finger still: only now can a drag make a range. */
  armed: boolean;
  /** Armed, and the finger moved on: the range is being made. */
  dragging: boolean;
  /** The span under the finger, current before the next render. */
  span: WordSpan;
  timer: ReturnType<typeof setTimeout> | null;
  restore: (() => void) | null;
};

type Options = {
  /** Select mode: a one-finger drag scrolls until a long press arms it. */
  enabled: boolean;
  listRef: RefObject<HTMLElement | null>;
  /** The armed finger moved on. Returns what puts the selection back if a second finger cancels the drag. */
  onDragStart: () => (() => void) | null;
  onCommit: (trackId: string, span: WordSpan) => void;
};

/**
 * The touch route to a word range (touch input grammar, #1051). One finger
 * moving scrolls and never selects. A long press on a word arms a range
 * there, and only then does moving on extend it over the words under the
 * finger. A hold that lifts without moving is not a drag, so the long press
 * on a word (word correction) is unchanged. The range shows as a draft while
 * the finger is down and becomes the selection when it lifts, so the
 * selection sheet does not open under the finger. A second finger cancels the
 * drag and puts the selection back. The click the browser sends after a
 * drag's lift is swallowed.
 */
export function useWordRangeDrag({
  enabled,
  listRef,
  onDragStart,
  onCommit,
}: Options) {
  const [draft, setDraft] = useState<WordRangeDraft | null>(null);
  const press = useRef<Press | null>(null);
  const liftedAt = useRef(Number.NEGATIVE_INFINITY);
  const frame = useRef<number | null>(null);
  const callbacks = useRef({ onDragStart, onCommit });
  callbacks.current = { onDragStart, onCommit };

  const stopFrame = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  };

  const clear = () => {
    const p = press.current;
    if (p?.timer) clearTimeout(p.timer);
    stopFrame();
    press.current = null;
    setDraft(null);
  };

  const cancel = () => {
    const restore = press.current?.dragging ? press.current.restore : null;
    clear();
    restore?.();
  };

  const extendTo = (p: Press) => {
    const hit = wordAtPoint(document, p.x, p.y);
    if (!hit || hit.trackId !== p.anchor.trackId) return;
    const next = spanBetween(p.anchor.wordIndex, hit.wordIndex);
    p.span = next;
    setDraft((cur) =>
      cur?.startWordIndex === next.startWordIndex &&
      cur.endWordIndex === next.endWordIndex
        ? cur
        : { trackId: p.anchor.trackId, ...next },
    );
  };

  const edgeScroll = () => {
    frame.current = null;
    const p = press.current;
    const list = listRef.current;
    if (!p?.dragging || !list) return;
    const box = list.getBoundingClientRect();
    const intoTop = box.top + EDGE_BAND_PX - p.y;
    const intoBottom = p.y - (box.bottom - EDGE_BAND_PX);
    const depth = intoTop > 0 ? -intoTop : intoBottom > 0 ? intoBottom : 0;
    if (depth !== 0) {
      list.scrollTop +=
        Math.sign(depth) * Math.min(EDGE_STEP_PX, Math.abs(depth) / 4 + 2);
      extendTo(p);
      frame.current = requestAnimationFrame(edgeScroll);
    }
  };

  const arm = (p: Press) => {
    p.timer = null;
    p.armed = true;
    listRef.current?.setPointerCapture?.(p.pointerId);
    setDraft({ trackId: p.anchor.trackId, ...p.span });
  };

  useEffect(() => {
    const list = listRef.current;
    if (!enabled || !list) return;
    const holdScroll = (event: Event) => {
      if (press.current?.armed && event.cancelable) event.preventDefault();
    };
    const holdMenu = (event: Event) => {
      if (press.current && event.cancelable) event.preventDefault();
    };
    list.addEventListener("touchmove", holdScroll, { passive: false });
    list.addEventListener("contextmenu", holdMenu);
    return () => {
      list.removeEventListener("touchmove", holdScroll);
      list.removeEventListener("contextmenu", holdMenu);
    };
  }, [enabled, listRef]);

  useEffect(() => () => clear(), []);

  useEffect(() => {
    if (!enabled && press.current) cancel();
  }, [enabled]);

  return {
    draft,
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      if (!enabled || event.pointerType !== "touch") return;
      if (press.current) cancel();
      if (!event.isPrimary) return;
      const target = event.target instanceof Element ? event.target : null;
      const chip = target?.closest<HTMLElement>("[data-transcript-word]");
      const wordIndex = Number(chip?.dataset.wordIndex);
      const trackId = chip?.dataset.trackId;
      if (!trackId || !Number.isInteger(wordIndex)) return;
      const p: Press = {
        pointerId: event.pointerId,
        anchor: { trackId, wordIndex },
        x: event.clientX,
        y: event.clientY,
        armed: false,
        dragging: false,
        span: spanBetween(wordIndex, wordIndex),
        timer: null,
        restore: null,
      };
      p.timer = setTimeout(() => arm(p), LONG_PRESS_MS);
      press.current = p;
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      const p = press.current;
      if (!p || p.pointerId !== event.pointerId) return;
      const moved =
        Math.hypot(event.clientX - p.x, event.clientY - p.y) > TOUCH_SLOP_PX;
      if (!p.armed) {
        if (moved) clear();
        return;
      }
      if (!p.dragging) {
        if (!moved) return;
        p.dragging = true;
        p.restore = callbacks.current.onDragStart();
      }
      p.x = event.clientX;
      p.y = event.clientY;
      extendTo(p);
      if (frame.current === null) {
        frame.current = requestAnimationFrame(edgeScroll);
      }
    },
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => {
      const p = press.current;
      if (!p || p.pointerId !== event.pointerId) return;
      if (!p.dragging) {
        clear();
        return;
      }
      liftedAt.current = Date.now();
      const { anchor, span } = p;
      clear();
      callbacks.current.onCommit(anchor.trackId, span);
    },
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => {
      if (press.current?.pointerId === event.pointerId) cancel();
    },
    /** True once for the click that follows a drag, so a word's click does not reset the range. */
    swallowClick: (): boolean => {
      if (!withinGhostClick(liftedAt.current)) return false;
      liftedAt.current = Number.NEGATIVE_INFINITY;
      return true;
    },
  };
}
