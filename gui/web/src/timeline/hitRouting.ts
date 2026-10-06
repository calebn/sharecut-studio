/**
 * Routes timeline `pointerdown` through the hit resolver (#1051). When the
 * pointer lands on a marked target and more than one target is in reach, the
 * resolver's winner gets the press instead of whatever CSS painted on top:
 * the original event stops at the document and an identical press is
 * replayed on the winner, so its own handlers (capture, drag, commit) run
 * unchanged. One target in reach, or a press on a plain surface, passes
 * through untouched.
 *
 * With the touch chooser lab on, a touch with 2+ targets in reach (on a
 * target or a surface) is held instead. Moving first replays it on the winner
 * (the surface itself when the finger is on no target); holding still opens
 * the chooser, whose chips commit a pick by replaying a tap, or a grab by
 * replaying the press and forwarding the drag, on the real target.
 */
import { HANDLE_DRAG_MIN_PX } from "../edit/dragThreshold";
import { GHOST_CLICK_MS } from "../hooks/touchGestureTiming";
import {
  CHOOSER_GRAB_MS,
  CHOOSER_HOLD_MS,
  CHOOSER_STILL_PX,
} from "./chooserLayout";
import type { HitPoint } from "./hitCandidates";
import {
  closestHitSurface,
  closestHitTarget,
  type ResolvedHit,
  resolveHits,
} from "./hitTargets";

const replayed = new WeakSet<Event>();

/** True for an event this module dispatched. */
export function isReplayed(event: Event): boolean {
  return replayed.has(event);
}

function pointOf(event: PointerEvent): HitPoint {
  return { x: event.clientX, y: event.clientY };
}

function travel(a: HitPoint, b: HitPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

type ReplayType = "pointerdown" | "pointermove" | "pointerup" | "pointercancel";

/** Dispatches a copy of `source` as `type` on `element`, at `at`. */
export function replayPointer(
  type: ReplayType,
  element: Element,
  source: PointerEvent,
  at: HitPoint = pointOf(source),
): void {
  const pressed = type === "pointerdown" || type === "pointermove";
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: type !== "pointercancel",
    composed: true,
    pointerId: source.pointerId,
    pointerType: source.pointerType,
    isPrimary: source.isPrimary,
    width: source.width,
    height: source.height,
    pressure: pressed ? Math.max(source.pressure, 0.5) : 0,
    clientX: at.x,
    clientY: at.y,
    screenX: source.screenX + (at.x - source.clientX),
    screenY: source.screenY + (at.y - source.clientY),
    button: type === "pointermove" ? -1 : 0,
    buttons: pressed ? 1 : 0,
    altKey: source.altKey,
    ctrlKey: source.ctrlKey,
    metaKey: source.metaKey,
    shiftKey: source.shiftKey,
  });
  replayed.add(event);
  element.dispatchEvent(event);
}

function replayClick(element: Element, source: PointerEvent, at: HitPoint) {
  const event = new PointerEvent("click", {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerId: source.pointerId,
    pointerType: source.pointerType,
    isPrimary: source.isPrimary,
    clientX: at.x,
    clientY: at.y,
    detail: 1,
  });
  replayed.add(event);
  element.dispatchEvent(event);
}

/** What the chooser shows; the router owns it and the view renders it. */
export interface ChooserView {
  origin: HitPoint;
  hits: readonly ResolvedHit[];
  page: number;
  /** The opening finger is still down: lifting on a chip picks it. */
  fingerDown: boolean;
  /** The chip under that finger: a hit index, "more", or none. */
  over: number | "more" | null;
}

/** Marks a chooser chip so the router can find it under a finger. */
export const CHOOSER_ITEM_ATTR = "data-chooser-item";

export interface HitRoutingOptions {
  chooserEnabled?: () => boolean;
  onChooser?: (view: ChooserView | null) => void;
}

export interface HitRouter {
  dispose: () => void;
  /** Commits chip `index`: a tap replay with `via`, or keyboard activation. */
  choose: (index: number, via: PointerEvent | null) => void;
  nextPage: () => void;
  /** Closes the chooser with no change. */
  close: () => void;
}

type Phase =
  | { kind: "idle" }
  | {
      kind: "routed";
      pointerId: number;
      element: Element;
      origin: HitPoint;
      moved: boolean;
    }
  | {
      kind: "holding";
      down: PointerEvent;
      origin: HitPoint;
      hits: ResolvedHit[];
      winner: Element;
      timer: ReturnType<typeof setTimeout>;
    }
  | {
      kind: "open";
      view: ChooserView;
      pointerId: number;
      rest: {
        index: number;
        at: HitPoint;
        timer: ReturnType<typeof setTimeout>;
      } | null;
    }
  | {
      kind: "grabbed";
      pointerId: number;
      element: Element;
      offset: HitPoint;
    };

const IDLE: Phase = { kind: "idle" };

/**
 * Installs the router on `root` (the marker lane plus the lanes). Listens at
 * the document in the capture phase so a routed press never reaches React.
 */
export function attachHitRouting(
  root: Element,
  options: HitRoutingOptions = {},
): HitRouter {
  const doc = root.ownerDocument;
  let phase: Phase = IDLE;
  let suppressClickUntil = 0;

  // A touch that began on a scrollable surface would otherwise pan the
  // timeline (and cancel the pointer) once it moves.
  const blockScroll = (event: TouchEvent) => {
    if (event.cancelable) event.preventDefault();
  };
  const holdScroll = (on: boolean) => {
    if (on) doc.addEventListener("touchmove", blockScroll, { passive: false });
    else doc.removeEventListener("touchmove", blockScroll);
  };
  const emit = (view: ChooserView | null) => options.onChooser?.(view);
  const setPhase = (next: Phase) => {
    if (phase.kind === "holding") clearTimeout(phase.timer);
    if (phase.kind === "open") {
      if (phase.rest) clearTimeout(phase.rest.timer);
      if (next.kind !== "open") emit(null);
    }
    if (next.kind === "idle") holdScroll(false);
    phase = next;
  };
  const stop = (event: Event) => {
    event.stopPropagation();
    if (event.cancelable) event.preventDefault();
  };
  /** The browser's own click would land on what the press first hit. */
  const replaceClick = (
    element: Element,
    source: PointerEvent,
    at: HitPoint,
    tap: boolean,
  ) => {
    suppressClickUntil = Date.now() + GHOST_CLICK_MS;
    if (tap) setTimeout(() => replayClick(element, source, at), 0);
  };
  const tapOn = (
    element: Element,
    down: PointerEvent,
    up: PointerEvent,
    at: HitPoint,
  ) => {
    replayPointer("pointerdown", element, down, at);
    replayPointer("pointerup", element, up, at);
    replaceClick(element, up, at, true);
  };
  const itemAt = (at: HitPoint): number | "more" | null => {
    const item = doc
      .elementFromPoint?.(at.x, at.y)
      ?.closest(`[${CHOOSER_ITEM_ATTR}]`)
      ?.getAttribute(CHOOSER_ITEM_ATTR);
    if (item == null) return null;
    return item === "more" ? "more" : Number(item);
  };

  const onDown = (event: PointerEvent) => {
    if (isReplayed(event)) return;
    if (phase.kind === "holding" && phase.down.pointerId !== event.pointerId) {
      // A second finger: no pick, and the new press passes through.
      setPhase(IDLE);
      return;
    }
    if (
      phase.kind !== "idle" ||
      !(event.target instanceof Element) ||
      !root.contains(event.target)
    ) {
      return;
    }
    const hit = closestHitTarget(event.target);
    if (!hit && !closestHitSurface(event.target)) return;
    const origin = pointOf(event);
    const hits = resolveHits(root, origin, event.pointerType, hit);
    if (hits.length < 2) return;
    const winner = hit ? hits[0].element : event.target;
    if (event.pointerType === "touch" && options.chooserEnabled?.()) {
      stop(event);
      holdScroll(true);
      phase = {
        kind: "holding",
        down: event,
        origin,
        hits,
        winner,
        timer: setTimeout(open, CHOOSER_HOLD_MS),
      };
      return;
    }
    if (winner === event.target || winner === hit) return;
    stop(event);
    if (event.pointerType === "touch") holdScroll(true);
    phase = {
      kind: "routed",
      pointerId: event.pointerId,
      element: winner,
      origin,
      moved: false,
    };
    replayPointer("pointerdown", winner, event);
  };

  const open = () => {
    if (phase.kind !== "holding") return;
    const { down, origin, hits } = phase;
    clearTimeout(phase.timer);
    phase = {
      kind: "open",
      pointerId: down.pointerId,
      rest: null,
      view: { origin, hits, page: 0, fingerDown: true, over: null },
    };
    emit(phase.view);
  };

  const grab = (source: PointerEvent) => {
    if (phase.kind !== "open" || !phase.rest) return;
    const { candidate, element } = phase.view.hits[phase.rest.index];
    const target = { x: candidate.x, y: candidate.y };
    const pointerId = phase.pointerId;
    setPhase({
      kind: "grabbed",
      pointerId,
      element,
      offset: { x: target.x - source.clientX, y: target.y - source.clientY },
    });
    replayPointer("pointerdown", element, source, target);
  };

  const onMove = (event: PointerEvent) => {
    if (isReplayed(event)) return;
    const at = pointOf(event);
    switch (phase.kind) {
      case "holding": {
        if (event.pointerId !== phase.down.pointerId) return;
        stop(event);
        if (travel(at, phase.origin) <= CHOOSER_STILL_PX) return;
        const { down, origin, winner } = phase;
        clearTimeout(phase.timer);
        phase = {
          kind: "routed",
          pointerId: down.pointerId,
          element: winner,
          origin,
          moved: true,
        };
        replayPointer("pointerdown", winner, down, origin);
        replayPointer("pointermove", winner, event);
        return;
      }
      case "open": {
        if (event.pointerId !== phase.pointerId || !phase.view.fingerDown)
          return;
        stop(event);
        const over = itemAt(at);
        const rest = phase.rest;
        if (typeof over !== "number") {
          if (rest) clearTimeout(rest.timer);
          phase.rest = null;
        } else if (
          !rest ||
          rest.index !== over ||
          travel(rest.at, at) > CHOOSER_STILL_PX
        ) {
          if (rest) clearTimeout(rest.timer);
          phase.rest = {
            index: over,
            at,
            timer: setTimeout(() => grab(event), CHOOSER_GRAB_MS),
          };
        }
        if (over !== phase.view.over) {
          phase.view = { ...phase.view, over };
          emit(phase.view);
        }
        return;
      }
      case "grabbed": {
        if (event.pointerId !== phase.pointerId) return;
        stop(event);
        replayPointer("pointermove", phase.element, event, {
          x: at.x + phase.offset.x,
          y: at.y + phase.offset.y,
        });
        return;
      }
      case "routed": {
        if (
          event.pointerId === phase.pointerId &&
          travel(at, phase.origin) >= HANDLE_DRAG_MIN_PX
        ) {
          phase.moved = true;
        }
        return;
      }
      default:
    }
  };

  const onUp = (event: PointerEvent) => {
    if (isReplayed(event)) return;
    const at = pointOf(event);
    switch (phase.kind) {
      case "holding": {
        if (event.pointerId !== phase.down.pointerId) return;
        const { down, origin, winner } = phase;
        stop(event);
        setPhase(IDLE);
        tapOn(winner, down, event, origin);
        return;
      }
      case "open": {
        if (event.pointerId !== phase.pointerId || !phase.view.fingerDown)
          return;
        stop(event);
        if (phase.rest) clearTimeout(phase.rest.timer);
        phase.rest = null;
        const over = itemAt(at);
        if (typeof over === "number") {
          router.choose(over, event);
          return;
        }
        // Lifting anywhere but a chip leaves the chips open to tap.
        suppressClickUntil = Date.now() + GHOST_CLICK_MS;
        phase.view = {
          ...phase.view,
          fingerDown: false,
          over: null,
          page: over === "more" ? phase.view.page + 1 : phase.view.page,
        };
        emit(phase.view);
        return;
      }
      case "grabbed": {
        if (event.pointerId !== phase.pointerId) return;
        const { element, offset } = phase;
        stop(event);
        setPhase(IDLE);
        const to = { x: at.x + offset.x, y: at.y + offset.y };
        replayPointer("pointerup", element, event, to);
        replaceClick(element, event, to, false);
        return;
      }
      case "routed": {
        if (event.pointerId !== phase.pointerId) return;
        const { element, moved } = phase;
        setPhase(IDLE);
        replaceClick(element, event, at, !moved);
        return;
      }
      default:
    }
  };

  const onCancel = (event: PointerEvent) => {
    if (isReplayed(event)) return;
    if (phase.kind === "grabbed" && phase.pointerId === event.pointerId) {
      const { element } = phase;
      setPhase(IDLE);
      replayPointer("pointercancel", element, event);
      return;
    }
    const pointerId =
      phase.kind === "holding"
        ? phase.down.pointerId
        : phase.kind === "idle"
          ? null
          : phase.pointerId;
    if (pointerId === event.pointerId) setPhase(IDLE);
  };

  const onClick = (event: MouseEvent) => {
    if (isReplayed(event) || Date.now() >= suppressClickUntil) return;
    suppressClickUntil = 0;
    event.stopPropagation();
    event.preventDefault();
  };

  const listeners = [
    ["pointerdown", onDown],
    ["pointermove", onMove],
    ["pointerup", onUp],
    ["pointercancel", onCancel],
    ["click", onClick],
  ] as const;
  for (const [type, listener] of listeners) {
    doc.addEventListener(type, listener as EventListener, true);
  }

  const router: HitRouter = {
    dispose() {
      setPhase(IDLE);
      for (const [type, listener] of listeners) {
        doc.removeEventListener(type, listener as EventListener, true);
      }
    },
    choose(index, via) {
      if (phase.kind !== "open") return;
      const hit = phase.view.hits[index];
      if (!hit) return;
      setPhase(IDLE);
      const { element, candidate } = hit;
      const at = { x: candidate.x, y: candidate.y };
      if (via) {
        tapOn(element, via, via, at);
      } else if (element instanceof HTMLElement) {
        element.click();
      } else {
        element.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            bubbles: true,
            cancelable: true,
          }),
        );
      }
      if (element instanceof HTMLElement || element instanceof SVGElement) {
        element.focus({ preventScroll: true });
      }
    },
    nextPage() {
      if (phase.kind !== "open") return;
      phase.view = { ...phase.view, page: phase.view.page + 1, over: null };
      emit(phase.view);
    },
    close() {
      if (phase.kind !== "open") return;
      setPhase(IDLE);
      // A tap outside closes on its press; its click must not reach whatever
      // the chooser was covering.
      suppressClickUntil = Date.now() + GHOST_CLICK_MS;
    },
  };
  return router;
}
