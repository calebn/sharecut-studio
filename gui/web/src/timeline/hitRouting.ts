/**
 * Routes timeline `pointerdown` through the hit resolver (#1051). When the
 * pointer lands on a marked target and more than one target is in reach, the
 * resolver's winner gets the press instead of whatever CSS painted on top:
 * the original event stops at the document and an identical press is
 * replayed on the winner, so its own handlers (capture, drag, commit) run
 * unchanged. One target in reach, or a press on a plain surface, passes
 * through untouched.
 *
 * With the touch chooser lab on, a touch on a target or surface that is not
 * already selected is handed to the press layer (`useTouchPress`, React Aria)
 * instead, and reaches no target while it decides. A touch the browser takes
 * to scroll ends in pointercancel and does nothing. A long press (the layer
 * calls `longPress`) opens the chooser over 2+ targets, or grabs the winner.
 * A release within the slop is a tap, replayed on the winner at once: React
 * Aria reports a press only from the click that follows, when the pointer is
 * no longer live and an owner that captures it would refuse the press. The
 * chooser's chips commit a pick the same way, or a grab by replaying the
 * press and forwarding the drag, on the real target. A finger on a chip grabs
 * by resting there, or by sliding along the target's drag axis once the chip
 * is armed (`chipGesture.ts`).
 */
import {
  CHIP_SETTLE_MS,
  GHOST_CLICK_MS,
  HANDLE_DRAG_MIN_PX,
  LONG_PRESS_MS,
  TOUCH_SLOP_PX,
} from "../hooks/gestureConstants";
import {
  AWAY,
  type ChipFinger,
  isArmed,
  moveOnChips,
  pressChip,
} from "./chipGesture";
import {
  HIT_KINDS,
  type HitKind,
  type HitPoint,
  isHitKind,
} from "./hitCandidates";
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
  /**
   * The chip under that finger: a hit index, "more", or none. Resting
   * `LONG_PRESS_MS` on a hit chip grabs its target.
   */
  over: number | "more" | null;
  /** The chip under the finger is armed: a slide along its axis drags it. */
  armed: boolean;
}

/** A target the router handed a press to, for the inspector to name. */
export interface RoutedTarget {
  kind: HitKind;
  id: string;
}

/** Marks a chooser chip so the router can find it under a finger. */
export const CHOOSER_ITEM_ATTR = "data-chooser-item";

export interface HitRoutingOptions {
  /** The touch chooser lab: touch goes through the press layer and chooser. */
  touchLab?: () => boolean;
  onChooser?: (view: ChooserView | null) => void;
  /**
   * A press went to a target (`null`: to a surface such as a clip body): a
   * tap, a chip pick, a grab, or a press on a target that takes it at once.
   */
  onTarget?: (target: RoutedTarget | null) => void;
}

export interface HitRouter {
  dispose: () => void;
  /** True when the press layer owns `down`, a touch the router deferred. */
  defers: (down: PointerEvent) => boolean;
  /** The press layer saw a long press: open the chooser, or grab the winner. */
  longPress: () => void;
  /**
   * Commits chip `index`: a tap replay for a pointer pick, or the target's
   * own activation for a keyboard or assistive-technology pick (`null`).
   */
  choose: (index: number, pointerType: string | null) => void;
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
      touch: boolean;
    }
  | {
      kind: "pressing";
      down: PointerEvent;
      origin: HitPoint;
      at: HitPoint;
      hits: ResolvedHit[];
      winner: Element;
      /** Another finger joined: a pinch or two-finger tap, never a pick. */
      multi: boolean;
    }
  | {
      kind: "open";
      view: ChooserView;
      pointerId: number;
      /** The finger that is down, if any, against the chips. */
      finger: ChipFinger;
      /** Rest-to-grab and settle timers for `finger`. */
      timers: ReturnType<typeof setTimeout>[];
    }
  | {
      kind: "grabbed";
      pointerId: number;
      element: Element;
      offset: HitPoint;
      origin: HitPoint;
      moved: boolean;
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
  /** The last real press, the source for a pick made on a chip. */
  let lastDown: PointerEvent | null = null;

  // Registered for the router's lifetime, not per gesture: WebKit only lets a
  // touch listener cancel scrolling if it was there when the touch began.
  const onTouchMove = (event: TouchEvent) => {
    const owned =
      phase.kind === "open" ||
      phase.kind === "grabbed" ||
      (phase.kind === "routed" && phase.touch);
    if (owned && event.cancelable) event.preventDefault();
  };
  root.addEventListener("touchmove", onTouchMove as EventListener, {
    passive: false,
  });

  const emit = (view: ChooserView | null) => options.onChooser?.(view);
  const setPhase = (next: Phase) => {
    if (phase.kind === "open") {
      for (const timer of phase.timers) clearTimeout(timer);
      if (next.kind !== "open") emit(null);
    }
    phase = next;
  };
  const report = (element: Element | null) => {
    const kind = element?.getAttribute("data-hit-kind");
    options.onTarget?.(
      element && isHitKind(kind)
        ? { kind, id: element.getAttribute("data-hit-id") ?? "" }
        : null,
    );
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
  /**
   * Presses `element` at `target`; the finger, which pressed at `finger`,
   * drives it from `offset` away. A finger already at `at` moves it there.
   */
  const grab = (
    element: Element,
    source: PointerEvent,
    target: HitPoint,
    finger: HitPoint,
    at: HitPoint = finger,
  ) => {
    const offset = { x: target.x - finger.x, y: target.y - finger.y };
    const moved = travel(at, finger) >= HANDLE_DRAG_MIN_PX;
    setPhase({
      kind: "grabbed",
      pointerId: source.pointerId,
      element,
      offset,
      origin: finger,
      moved,
    });
    report(element);
    replayPointer("pointerdown", element, source, target);
    if (moved) {
      replayPointer("pointermove", element, source, {
        x: at.x + offset.x,
        y: at.y + offset.y,
      });
    }
  };
  /** Grabs chip `index`'s target, measured from where the finger settled. */
  const grabChip = (
    index: number,
    source: PointerEvent,
    anchor: HitPoint,
    at: HitPoint = anchor,
  ) => {
    if (phase.kind !== "open") return;
    const { candidate, element } = phase.view.hits[index];
    grab(element, source, candidate, anchor, at);
  };
  /** The open chooser's finger is now `finger`; a new anchor restarts its timers. */
  const setFinger = (finger: ChipFinger, source: PointerEvent) => {
    if (phase.kind !== "open") return;
    const open = phase;
    const prev = open.finger;
    open.finger = finger;
    const anchor = finger.kind === "over" ? finger.anchor : null;
    if (anchor === (prev.kind === "over" ? prev.anchor : null)) return;
    for (const timer of open.timers) clearTimeout(timer);
    open.timers = [];
    if (finger.kind !== "over") return;
    const current = () =>
      phase === open &&
      open.finger.kind === "over" &&
      open.finger.anchor === anchor
        ? open.finger
        : null;
    open.timers.push(
      setTimeout(() => {
        const f = current();
        if (f) grabChip(f.index, source, f.rest ?? f.last);
      }, LONG_PRESS_MS),
    );
    if (!finger.pressed) {
      open.timers.push(
        setTimeout(() => {
          if (!current()) return;
          open.view = { ...open.view, armed: true };
          emit(open.view);
        }, CHIP_SETTLE_MS),
      );
    }
  };

  const onDown = (event: PointerEvent) => {
    if (isReplayed(event)) return;
    lastDown = event;
    if (phase.kind === "pressing" && phase.down.pointerId !== event.pointerId) {
      phase.multi = true;
      return;
    }
    if (
      phase.kind === "open" &&
      !phase.view.fingerDown &&
      event.pointerType !== "mouse"
    ) {
      // A finger pressing a chip left open: lift to pick, slide along the
      // target's axis to drag it. Mouse, keys and AT pick through the chip.
      const at = pointOf(event);
      const over = itemAt(at);
      if (typeof over !== "number") return;
      stop(event);
      phase.pointerId = event.pointerId;
      setFinger(pressChip(over, at, Date.now()), event);
      phase.view = { ...phase.view, fingerDown: true, over, armed: true };
      emit(phase.view);
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
    const winner = hit ? hits[0].element : event.target;
    const touch = event.pointerType === "touch";
    // Select first, then drag: the finger on a selected target drags it at
    // once, and an armed Select range owns every touch. Anything else, even a
    // spot where a selected neighbour would win a tap, waits for the press
    // layer, so a hold there still opens the chooser.
    const onSelected = hits.some(
      (h) => h.element === hit && h.candidate.selected,
    );
    if (
      touch &&
      options.touchLab?.() &&
      !onSelected &&
      !event.target.closest("[data-range-armed]")
    ) {
      phase = {
        kind: "pressing",
        down: event,
        origin,
        at: origin,
        hits,
        winner,
        multi: false,
      };
      return;
    }
    report(winner);
    if (hits.length < 2 || winner === event.target || winner === hit) return;
    stop(event);
    phase = {
      kind: "routed",
      pointerId: event.pointerId,
      element: winner,
      origin,
      moved: false,
      touch,
    };
    replayPointer("pointerdown", winner, event);
  };

  const onMove = (event: PointerEvent) => {
    if (isReplayed(event)) return;
    const at = pointOf(event);
    switch (phase.kind) {
      case "pressing": {
        if (event.pointerId === phase.down.pointerId) phase.at = at;
        return;
      }
      case "open": {
        if (event.pointerId !== phase.pointerId || !phase.view.fingerDown)
          return;
        stop(event);
        const over = itemAt(at);
        const index = typeof over === "number" ? over : null;
        const axis =
          index == null
            ? "none"
            : HIT_KINDS[phase.view.hits[index].candidate.kind].axis;
        const now = Date.now();
        const step = moveOnChips(phase.finger, index, axis, at, now);
        if (step.grab && step.finger.kind === "over" && step.finger.rest) {
          // Measured from where the finger rested, so the slop's travel
          // moves the target too.
          grabChip(step.finger.index, event, step.finger.rest, at);
          return;
        }
        setFinger(step.finger, event);
        const armed = index != null && isArmed(step.finger, now);
        if (over !== phase.view.over || armed !== phase.view.armed) {
          phase.view = { ...phase.view, over, armed };
          emit(phase.view);
        }
        return;
      }
      case "grabbed": {
        if (event.pointerId !== phase.pointerId) return;
        stop(event);
        if (travel(at, phase.origin) >= HANDLE_DRAG_MIN_PX) phase.moved = true;
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
      case "pressing": {
        if (event.pointerId !== phase.down.pointerId) return;
        // A tap, replayed while the pointer is live. The press layer stops
        // the browser's own click, so no target sees two.
        phase.at = at;
        const press = settle();
        if (!press) return;
        const { winner, down, origin } = press;
        report(winner);
        replayPointer("pointerdown", winner, down, origin);
        replayPointer("pointerup", winner, event, origin);
        setTimeout(() => replayClick(winner, event, origin), 0);
        return;
      }
      case "open": {
        if (!phase.view.fingerDown) {
          // A tap on a chip left open: pick while the pointer is live.
          const over = itemAt(at);
          if (typeof over === "number") router.choose(over, event.pointerType);
          return;
        }
        if (event.pointerId !== phase.pointerId) return;
        stop(event);
        setFinger(AWAY, event);
        const over = itemAt(at);
        if (typeof over === "number") {
          router.choose(over, event.pointerType);
          return;
        }
        // Lifting anywhere but a chip leaves the chips open to tap.
        suppressClickUntil = Date.now() + GHOST_CLICK_MS;
        phase.view = {
          ...phase.view,
          fingerDown: false,
          over: null,
          armed: false,
          page: over === "more" ? phase.view.page + 1 : phase.view.page,
        };
        emit(phase.view);
        return;
      }
      case "grabbed": {
        if (event.pointerId !== phase.pointerId) return;
        const { element, offset, moved } = phase;
        stop(event);
        setPhase(IDLE);
        const to = { x: at.x + offset.x, y: at.y + offset.y };
        replayPointer("pointerup", element, event, to);
        // A hold released where it started is a slow tap.
        replaceClick(element, event, to, !moved);
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
    // React Aria's long press cancels its own press with an untyped event.
    if (isReplayed(event) || !event.pointerType) return;
    if (phase.kind === "grabbed" && phase.pointerId === event.pointerId) {
      const { element } = phase;
      setPhase(IDLE);
      replayPointer("pointercancel", element, event);
      return;
    }
    const pointerId =
      phase.kind === "pressing"
        ? phase.down.pointerId
        : phase.kind === "idle"
          ? null
          : phase.pointerId;
    if (pointerId === event.pointerId) setPhase(IDLE);
  };

  const onClick = (event: MouseEvent) => {
    if (isReplayed(event) || Date.now() >= suppressClickUntil) return;
    // A chip's own press needs its click.
    if (
      event.target instanceof Element &&
      event.target.closest(`[${CHOOSER_ITEM_ATTR}]`)
    ) {
      return;
    }
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

  /** The deferred press, if the finger stayed within the slop and alone. */
  const settle = () => {
    if (phase.kind !== "pressing") return null;
    const press = phase;
    setPhase(IDLE);
    return !press.multi && travel(press.at, press.origin) <= TOUCH_SLOP_PX
      ? press
      : null;
  };

  const router: HitRouter = {
    dispose() {
      setPhase(IDLE);
      root.removeEventListener("touchmove", onTouchMove as EventListener);
      for (const [type, listener] of listeners) {
        doc.removeEventListener(type, listener as EventListener, true);
      }
    },
    defers(down) {
      return phase.kind === "pressing" && phase.down === down;
    },
    longPress() {
      const press = settle();
      if (!press) return;
      const { down, origin, hits, winner } = press;
      if (hits.length < 2) {
        grab(winner, down, origin, origin);
        return;
      }
      phase = {
        kind: "open",
        pointerId: down.pointerId,
        finger: AWAY,
        timers: [],
        view: {
          origin,
          hits,
          page: 0,
          fingerDown: true,
          over: null,
          armed: false,
        },
      };
      emit(phase.view);
    },
    choose(index, pointerType) {
      if (phase.kind !== "open") return;
      const hit = phase.view.hits[index];
      if (!hit) return;
      setPhase(IDLE);
      const { element, candidate } = hit;
      report(element);
      const at = { x: candidate.x, y: candidate.y };
      const pointer =
        pointerType === "touch" ||
        pointerType === "mouse" ||
        pointerType === "pen";
      if (pointer && lastDown) {
        tapOn(element, lastDown, lastDown, at);
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
      phase.view = {
        ...phase.view,
        page: phase.view.page + 1,
        over: null,
        armed: false,
      };
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
