import { type RefObject, useLayoutEffect, useMemo, useRef } from "react";
import { LONG_PRESS_MS } from "../hooks/gestureConstants";
import {
  edgeScrollDelta,
  type PressKind,
  pressKind,
  pressSlop,
  type ScriptGesture,
} from "./scriptGesture";
import type { ScriptStop, WordsSelection } from "./scriptPieces";
import { extendTo } from "./scriptSelection";

/** What the pane gives the gestures: reads of its layout and the ways to tell the host. */
export type GestureControl = {
  /** The word a press landed on, or null when it landed anywhere else (a pill, a run, the margin, a grip). */
  wordAt: (target: Element) => number | null;
  /** The place under or nearest a client point, or null when none is drawn. */
  stopAt: (x: number, y: number) => ScriptStop | null;
  /** The anchor a press on word `index` starts from: with Shift, the selection's own. */
  anchorFor: (index: number, shift: boolean) => number;
  /** A drag or hold is about to start. False refuses it. */
  start: (anchor: number, gesture: ScriptGesture) => boolean;
  /** The selection being made, drawn but not committed; null clears it. */
  draft: (selection: WordsSelection | null) => void;
  change: (anchor: number, head: number, gesture: ScriptGesture) => void;
  end: (
    anchor: number,
    head: number,
    gesture: ScriptGesture,
    committed: boolean,
  ) => void;
  /** The gesture scrolled the body by itself. */
  scrolled: () => void;
};

type Press = {
  id: number;
  kind: PressKind;
  x0: number;
  y0: number;
  x: number;
  y: number;
  anchor: number;
  head: number;
  gesture: ScriptGesture;
  selecting: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  frame: number | null;
  scrolled: boolean;
};

/** How long after a release the click it causes can still arrive. */
const CLICK_AFTER_RELEASE_MS = 100;

const insideGrip = (target: EventTarget | null) =>
  target instanceof Element && target.closest(".sys-handle") !== null;

/**
 * The script body's pointer gestures, by delegation: one set of listeners on
 * the body however many words it holds. A drag (mouse, pen) or a long press
 * then drag (touch) selects from the pressed word; release commits, anything
 * else ends it uncommitted. `consumeClick` swallows the click the browser
 * sends after a gesture.
 */
export function useScriptGestures(
  bodyRef: RefObject<HTMLElement | null>,
  active: boolean,
  control: GestureControl,
) {
  const ctl = useRef(control);
  useLayoutEffect(() => {
    ctl.current = control;
  });
  const lastKind = useRef<PressKind>("mouse");
  const swallow = useRef(false);

  // A layout effect so the listeners exist in the commit that draws the body, before any press can land.
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body || !active) return;
    let press: Press | null = null;
    let watching: AbortController | null = null;

    const release = () => {
      const p = press;
      press = null;
      watching?.abort();
      watching = null;
      if (!p) return;
      if (p.timer) clearTimeout(p.timer);
      if (p.frame !== null) cancelAnimationFrame(p.frame);
      try {
        body.releasePointerCapture?.(p.id);
      } catch {
        // The capture is already gone.
      }
    };

    const track = (p: Press) => {
      const stop = ctl.current.stopAt(p.x, p.y);
      if (!stop) return;
      const next = extendTo(p.anchor, stop);
      if (next.head === p.head) return;
      p.head = next.head;
      ctl.current.draft(next);
      ctl.current.change(p.anchor, p.head, p.gesture);
    };

    // Only the click that belongs to this gesture's own release is eaten:
    // one that comes later, with no pointerdown of its own (assistive
    // technology, switch or voice control), is a real click.
    let swallowTimer: ReturnType<typeof setTimeout> | null = null;
    let swallowWatch: AbortController | null = null;
    const forgetSwallow = () => {
      if (swallowTimer) clearTimeout(swallowTimer);
      swallowTimer = null;
      swallowWatch?.abort();
      swallowWatch = null;
      swallow.current = false;
    };
    const armSwallow = (id: number, released: boolean) => {
      forgetSwallow();
      swallow.current = true;
      const soon = () => {
        swallowTimer = setTimeout(forgetSwallow, CLICK_AFTER_RELEASE_MS);
      };
      if (released) {
        soon();
        return;
      }
      // Ended early (Esc, blur): the click, if any, comes at the real release.
      swallowWatch = new AbortController();
      const { signal } = swallowWatch;
      const onEnd = (event: PointerEvent) => {
        if (event.pointerId !== id) return;
        swallowWatch?.abort();
        swallowWatch = null;
        if (event.type === "pointercancel") forgetSwallow();
        else soon();
      };
      window.addEventListener("pointerup", onEnd, { capture: true, signal });
      window.addEventListener("pointercancel", onEnd, {
        capture: true,
        signal,
      });
    };

    const finish = (committed: boolean, at?: { x: number; y: number }) => {
      const p = press;
      if (!p) return;
      if (committed && p.selecting && at) {
        p.x = at.x;
        p.y = at.y;
        track(p);
      }
      release();
      if (!p.selecting) return;
      armSwallow(p.id, committed && at !== undefined);
      ctl.current.end(
        p.anchor,
        p.head < 0 ? p.anchor : p.head,
        p.gesture,
        committed,
      );
    };

    const begin = (p: Press, drawAnchor: boolean): boolean => {
      if (!ctl.current.start(p.anchor, p.gesture)) {
        release();
        return false;
      }
      p.selecting = true;
      try {
        body.setPointerCapture?.(p.id);
      } catch {
        // A synthetic pointer has nothing to capture.
      }
      if (drawAnchor) {
        p.head = p.anchor;
        ctl.current.draft({ kind: "words", anchor: p.anchor, head: p.anchor });
        ctl.current.change(p.anchor, p.head, p.gesture);
      }
      return true;
    };

    const autoscroll = (p: Press) => {
      if (p.frame !== null) return;
      const tick = () => {
        p.frame = null;
        if (press !== p) return;
        const box = body.getBoundingClientRect();
        const delta = edgeScrollDelta(p.y, box.top, box.bottom);
        if (delta === 0) return;
        const before = body.scrollTop;
        body.scrollTop = before + delta;
        if (body.scrollTop === before) return;
        if (!p.scrolled) {
          p.scrolled = true;
          ctl.current.scrolled();
        }
        track(p);
        p.frame = requestAnimationFrame(tick);
      };
      p.frame = requestAnimationFrame(tick);
    };

    const onDown = (event: PointerEvent) => {
      const kind = pressKind(event.pointerType);
      lastKind.current = kind;
      forgetSwallow();
      if (insideGrip(event.target)) return;
      if (press) {
        // A second finger is a pinch or a mistake: the earlier selection stays.
        if (
          kind === "touch" &&
          press.kind === "touch" &&
          event.pointerId !== press.id
        ) {
          finish(false);
        }
        return;
      }
      if (!event.isPrimary) return;
      if (kind !== "touch" && (event.button !== 0 || event.ctrlKey)) return;
      const target = event.target instanceof Element ? event.target : null;
      const word = target ? ctl.current.wordAt(target) : null;
      if (word === null) return;
      const shift = event.shiftKey;
      const p: Press = {
        id: event.pointerId,
        kind,
        x0: event.clientX,
        y0: event.clientY,
        x: event.clientX,
        y: event.clientY,
        anchor: ctl.current.anchorFor(word, shift && kind !== "touch"),
        head: -1,
        gesture: {
          source: kind,
          intent: kind === "touch" ? "hold" : shift ? "extend" : "drag",
          shift,
          alt: event.altKey,
          mod: event.ctrlKey || event.metaKey,
        },
        selecting: false,
        timer: null,
        frame: null,
        scrolled: false,
      };
      press = p;
      watching = new AbortController();
      const { signal } = watching;
      document.addEventListener(
        "keydown",
        (key) => {
          if (key.key !== "Escape" || !press?.selecting) return;
          key.preventDefault();
          key.stopPropagation();
          finish(false);
        },
        { capture: true, signal },
      );
      window.addEventListener("blur", () => finish(false), { signal });
      if (kind === "touch") {
        p.timer = setTimeout(() => {
          p.timer = null;
          if (press === p) begin(p, true);
        }, LONG_PRESS_MS);
      }
    };

    const onMove = (event: PointerEvent) => {
      const p = press;
      if (!p || event.pointerId !== p.id) return;
      p.x = event.clientX;
      p.y = event.clientY;
      if (!p.selecting) {
        const moved = Math.hypot(p.x - p.x0, p.y - p.y0);
        if (p.kind === "touch") {
          if (moved > pressSlop("touch")) release();
          return;
        }
        if (moved < pressSlop(p.kind)) return;
        if (!begin(p, false)) return;
      }
      track(p);
      autoscroll(p);
    };

    const onUp = (event: PointerEvent) => {
      if (press && event.pointerId === press.id) {
        finish(true, { x: event.clientX, y: event.clientY });
      }
    };
    const onCancel = (event: PointerEvent) => {
      if (press && event.pointerId === press.id) finish(false);
    };
    const onLost = (event: PointerEvent) => {
      // lostpointercapture bubbles: the word losing Chrome's implicit touch
      // capture to the body is the hand-over, not a lost gesture.
      if (event.target !== body) return;
      if (press?.selecting && event.pointerId === press.id) finish(false);
    };
    const holdScroll = (event: TouchEvent) => {
      if (press?.selecting && event.cancelable) event.preventDefault();
    };
    const holdMenu = (event: Event) => {
      if (press && (press.selecting || press.kind === "touch")) {
        event.preventDefault();
      }
    };
    const holdText = (event: Event) => {
      if (press) event.preventDefault();
    };

    body.addEventListener("pointerdown", onDown);
    body.addEventListener("pointermove", onMove);
    body.addEventListener("pointerup", onUp);
    body.addEventListener("pointercancel", onCancel);
    body.addEventListener("lostpointercapture", onLost);
    body.addEventListener("touchmove", holdScroll, { passive: false });
    body.addEventListener("contextmenu", holdMenu);
    body.addEventListener("selectstart", holdText);
    body.addEventListener("dragstart", holdText);
    return () => {
      body.removeEventListener("pointerdown", onDown);
      body.removeEventListener("pointermove", onMove);
      body.removeEventListener("pointerup", onUp);
      body.removeEventListener("pointercancel", onCancel);
      body.removeEventListener("lostpointercapture", onLost);
      body.removeEventListener("touchmove", holdScroll);
      body.removeEventListener("contextmenu", holdMenu);
      body.removeEventListener("selectstart", holdText);
      body.removeEventListener("dragstart", holdText);
      finish(false);
      release();
      forgetSwallow();
    };
  }, [bodyRef, active]);

  return useMemo(
    () => ({
      lastKind,
      consumeClick: (): boolean => {
        const was = swallow.current;
        swallow.current = false;
        return was;
      },
    }),
    [],
  );
}
