/**
 * Routes timeline `pointerdown` through the hit resolver (#1051). When the
 * pointer lands on a marked target and more than one target is in reach, the
 * resolver's winner gets the press instead of whatever CSS painted on top:
 * the original event stops at the document and an identical press is
 * replayed on the winner, so its own handlers (capture, drag, commit) run
 * unchanged. One target in reach, or a press on a plain surface, passes
 * through untouched.
 *
 * With the touch chooser lab on, every touch on a target or surface follows
 * the touch input grammar (`inputContract.ts`). It is handed to the press
 * layer (`useTouchPress`, React Aria) and reaches no target while it decides:
 * - One finger moving scrolls: the browser takes it, it ends in
 *   pointercancel, and nothing is edited, selected target or not.
 * - A release within the slop is a tap, replayed on the winner at once:
 *   React Aria reports a press only from the click that follows, when the
 *   pointer is no longer live and an owner that captures it would refuse it.
 * - A long press (the layer calls `longPress`) over 2+ targets opens the
 *   chooser. Over one target it arms it, if the contract lets it drag, or
 *   selects it. A clip body under the finger is that one target when no
 *   other is in reach. Over no target it opens the create menu.
 * - Only an armed target drags, and only along its own axes. It drags from
 *   where it is, with a brief detent at each soft boundary (`dragDetent.ts`),
 *   and lifting commits it.
 * The chooser's chips commit a pick the same way, or arm by replaying the
 * press and forwarding the drag, on the real target. A finger on a chip arms
 * it by resting there, or by sliding along the target's drag axis once the
 * chip is armed (`chipGesture.ts`).
 *
 * Pinch never edits: the moment a second finger lands on the timeline, every
 * pointer's uncommitted action (an armed drag, trim, fade, chip grab, range,
 * create menu or a press still deciding) gets a `pointercancel`, which each
 * owner already treats as "drop the draft, save nothing", and the selection
 * goes back to what it was before the first press. Until every pointer lifts,
 * their pointer events stop here, so the pinch or pan (touch events) owns them.
 */

import type { SoftBoundary } from "../edit/nudgeBoundaries";
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
  boundaryX,
  type DetentTrack,
  detentMove,
  startDetents,
} from "./dragDetent";
import type { HitPoint } from "./hitCandidates";
import {
  closestHitSurface,
  closestHitTarget,
  hitSpanSec,
  hitTimeSec,
  type ResolvedHit,
  resolveHits,
} from "./hitTargets";
import {
  type DragAxis,
  HIT_KINDS,
  type HitKind,
  isHitKind,
  longPressAction,
} from "./inputContract";

const replayed = new WeakSet<Event>();

/** True for an event this module dispatched. */
export function isReplayed(event: Event): boolean {
  return replayed.has(event);
}

function pointOf(event: PointerEvent): HitPoint {
  return { x: event.clientX, y: event.clientY };
}

function isBody(element: Element): boolean {
  const kind = element.getAttribute("data-hit-kind");
  return isHitKind(kind) && HIT_KINDS[kind].body;
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
/** Marks a create menu item so the router can find it under a finger. */
export const CREATE_ITEM_ATTR = "data-create-item";
/** Set on a target while it is armed, for its armed look. */
export const ARMED_ATTR = "data-hit-armed";

/** What the create menu shows; the router owns it and the view renders it. */
export interface CreateView {
  /** Where the long-press landed, viewport px. */
  origin: HitPoint;
  /** The surface under it: a lane, the envelope layer, a pending region. */
  surface: Element;
  /** The opening finger is still down: lifting on an item picks it. */
  fingerDown: boolean;
  /** The item under that finger, by index. */
  over: number | null;
}

/** An armed target, for the timeline to name and announce. */
export interface ArmedTarget extends RoutedTarget {
  axis: DragAxis;
}

/** A soft boundary holding an armed drag, at viewport x. */
export interface DetentView {
  x: number;
  boundary: SoftBoundary;
}

export interface HitRoutingOptions {
  /** The touch chooser lab: touch goes through the press layer and chooser. */
  touchLab?: () => boolean;
  onChooser?: (view: ChooserView | null) => void;
  onCreate?: (view: CreateView | null) => void;
  /** A target was armed (`null`: the armed drag ended or was cancelled). */
  onArm?: (armed: ArmedTarget | null) => void;
  /**
   * The soft boundaries, in timeline seconds, an armed `target` (at `sec`)
   * detents at; none when absent.
   */
  detents?: (target: RoutedTarget, sec: number) => readonly SoftBoundary[];
  /** The timeline's zoom, to place those boundaries. */
  pxPerSec?: () => number;
  /** An armed drag reached a soft boundary (`null`: it left it, or ended). */
  onDetent?: (detent: DetentView | null) => void;
  /**
   * A press went to a target (`null`: to a surface such as a clip body): a
   * tap, a chip pick, an arm, or a press on a target that takes it at once.
   */
  onTarget?: (target: RoutedTarget | null) => void;
  /**
   * Called as the first pointer lands, before any target sees it; the
   * returned function puts back what that press changed (the selection) when
   * a second finger turns the gesture into a pinch or pan.
   */
  snapshot?: () => () => void;
}

export interface HitRouter {
  dispose: () => void;
  /** True when the press layer owns `down`, a touch the router deferred. */
  defers: (down: PointerEvent) => boolean;
  /**
   * The press layer saw a long press: open the chooser, arm or select the
   * one target, or open the create menu.
   */
  longPress: () => void;
  /**
   * Commits chip `index`: a tap replay for a pointer pick, or the target's
   * own activation for a keyboard or assistive-technology pick (`null`).
   */
  choose: (index: number, pointerType: string | null) => void;
  nextPage: () => void;
  /** Closes the chooser or the create menu with no change. */
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
      kind: "create";
      view: CreateView;
      pointerId: number;
    }
  | {
      /** An armed target: the finger drives it along its axes. */
      kind: "grabbed";
      pointerId: number;
      element: Element;
      offset: HitPoint;
      origin: HitPoint;
      moved: boolean;
      axis: DragAxis;
      /** Where the target was armed; an `x` drag keeps this y. */
      from: HitPoint;
      /** Where it last went. */
      at: HitPoint;
      detents: DetentTrack | null;
    };

const IDLE: Phase = { kind: "idle" };

/** Every finger (touch pointer) down on the timeline, and whether two or more met there. */
interface MultiTouch {
  /** By pointer id, the press each began with. */
  pointers: Map<number, PointerEvent>;
  /** A second finger landed: pinch or pan owns them all until all lift. */
  multi: boolean;
  /** Puts back what the first press changed (`HitRoutingOptions.snapshot`). */
  restore: (() => void) | null;
}

/**
 * Installs the router on `root` (the marker lane plus the lanes). Listens at
 * the document in the capture phase so a routed press never reaches React.
 */
export function attachHitRouting(
  root: Element,
  options: HitRoutingOptions = {},
): HitRouter {
  const doc = root.ownerDocument;
  // The whole timeline, ruler and headers included: a pinch can start there.
  const scope = root.closest(".timeline-scroll") ?? root;
  let phase: Phase = IDLE;
  const gesture: MultiTouch = {
    pointers: new Map(),
    multi: false,
    restore: null,
  };
  let suppressClickUntil = 0;
  /** The last real press, the source for a pick made on a chip. */
  let lastDown: PointerEvent | null = null;

  // Registered for the router's lifetime, not per gesture: WebKit only lets a
  // touch listener cancel scrolling if it was there when the touch began.
  const onTouchMove = (event: TouchEvent) => {
    const owned =
      phase.kind === "open" ||
      phase.kind === "grabbed" ||
      (phase.kind === "create" && phase.view.fingerDown) ||
      (phase.kind === "routed" && phase.touch);
    if (owned && event.cancelable) event.preventDefault();
  };
  root.addEventListener("touchmove", onTouchMove as EventListener, {
    passive: false,
  });

  const emit = (view: ChooserView | null) => options.onChooser?.(view);
  const emitCreate = (view: CreateView | null) => options.onCreate?.(view);
  const setPhase = (next: Phase) => {
    if (phase.kind === "open") {
      for (const timer of phase.timers) clearTimeout(timer);
      if (next.kind !== "open") emit(null);
    }
    if (phase.kind === "create" && next.kind !== "create") emitCreate(null);
    if (phase.kind === "grabbed" && next !== phase) {
      phase.element.removeAttribute(ARMED_ATTR);
      if (phase.detents?.held) options.onDetent?.(null);
      options.onArm?.(null);
    }
    phase = next;
  };
  const targetOf = (element: Element | null): RoutedTarget | null => {
    const kind = element?.getAttribute("data-hit-kind");
    return element && isHitKind(kind)
      ? { kind, id: element.getAttribute("data-hit-id") ?? "" }
      : null;
  };
  const report = (element: Element | null) =>
    options.onTarget?.(targetOf(element));
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
  const createItemAt = (at: HitPoint): Element | null =>
    doc.elementFromPoint?.(at.x, at.y)?.closest(`[${CREATE_ITEM_ATTR}]`) ??
    null;
  /**
   * Where an armed target goes for a finger at `at`: along its own axes
   * only, and held at a soft boundary until pushed past it.
   */
  const drive = (
    armed: Extract<Phase, { kind: "grabbed" }>,
    at: HitPoint,
  ): HitPoint => {
    const wantX = at.x + armed.offset.x;
    const y = armed.axis === "x" ? armed.from.y : at.y + armed.offset.y;
    if (!armed.detents) return { x: wantX, y };
    const step = detentMove(armed.detents, wantX);
    if (step.caught) {
      options.onDetent?.({
        x: boundaryX(armed.detents, step.caught),
        boundary: step.caught,
      });
    } else if (step.released) {
      options.onDetent?.(null);
    }
    return { x: step.x, y };
  };
  /**
   * Arms `element`: presses it at `target`; the finger, which pressed at
   * `finger`, drives it from `offset` away along the target's own axes. A
   * finger already at `at` moves it there.
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
    const routed = targetOf(element);
    const sec = hitTimeSec(element);
    const boundaries =
      routed && Number.isFinite(sec)
        ? (options.detents?.(routed, sec) ?? [])
        : [];
    const pxPerSec = options.pxPerSec?.() ?? 0;
    const span = hitSpanSec(element);
    const armed: Extract<Phase, { kind: "grabbed" }> = {
      kind: "grabbed",
      pointerId: source.pointerId,
      element,
      offset,
      origin: finger,
      moved,
      axis: routed ? HIT_KINDS[routed.kind].axis : "xy",
      from: target,
      at: target,
      detents:
        boundaries.length > 0 && pxPerSec > 0
          ? startDetents(
              sec,
              target.x,
              pxPerSec,
              boundaries,
              // A body is held where the finger is, away from its start.
              span > 0
                ? { span, anchorX: element.getBoundingClientRect().left }
                : undefined,
            )
          : null,
    };
    setPhase(armed);
    element.setAttribute(ARMED_ATTR, "");
    if (routed) options.onArm?.({ ...routed, axis: armed.axis });
    report(element);
    replayPointer("pointerdown", element, source, target);
    if (moved) {
      armed.at = drive(armed, at);
      replayPointer("pointermove", element, source, armed.at);
    }
  };
  /**
   * Chip `index`'s target, measured from where the finger settled: armed if
   * it drags, else selected, as a long-press on it would.
   */
  const grabChip = (
    index: number,
    source: PointerEvent,
    anchor: HitPoint,
    at: HitPoint = anchor,
  ) => {
    if (phase.kind !== "open") return;
    const { candidate, element } = phase.view.hits[index];
    if (longPressAction(candidate.kind) === "select") {
      router.choose(index, source.pointerType);
      return;
    }
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
    // A tap on a body is its own, though a target in reach takes a long-press.
    const winner =
      hit && !isBody(hit) ? hits[0].element : (hit ?? event.target);
    const touch = event.pointerType === "touch";
    // One finger moving never edits: every touch, on a selected target too,
    // waits for the press layer, which arms only on a long press. An armed
    // Select range is the one mode that owns its touches.
    if (
      touch &&
      options.touchLab?.() &&
      !event.target.closest("[data-range-armed]")
    ) {
      phase = {
        kind: "pressing",
        down: event,
        origin,
        at: origin,
        hits,
        winner,
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
      case "create": {
        if (event.pointerId !== phase.pointerId || !phase.view.fingerDown)
          return;
        stop(event);
        const item = createItemAt(at);
        const over = item ? Number(item.getAttribute(CREATE_ITEM_ATTR)) : null;
        if (over !== phase.view.over) {
          phase.view = { ...phase.view, over };
          emitCreate(phase.view);
        }
        return;
      }
      case "grabbed": {
        if (event.pointerId !== phase.pointerId) return;
        stop(event);
        if (travel(at, phase.origin) >= HANDLE_DRAG_MIN_PX) phase.moved = true;
        phase.at = drive(phase, at);
        replayPointer("pointermove", phase.element, event, phase.at);
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
      case "create": {
        if (!phase.view.fingerDown || event.pointerId !== phase.pointerId)
          return;
        stop(event);
        suppressClickUntil = Date.now() + GHOST_CLICK_MS;
        const item = createItemAt(at);
        if (item) {
          // Picked by lifting on it: the item's own click runs its command.
          setPhase(IDLE);
          replayClick(item, event, at);
          return;
        }
        // Lifting anywhere but an item leaves the menu open to tap.
        phase.view = { ...phase.view, fingerDown: false, over: null };
        emitCreate(phase.view);
        return;
      }
      case "grabbed": {
        if (event.pointerId !== phase.pointerId) return;
        const armed = phase;
        stop(event);
        const to = drive(armed, at);
        setPhase(IDLE);
        replayPointer("pointerup", armed.element, event, to);
        // A hold released where it started is a slow tap.
        replaceClick(armed.element, event, to, !armed.moved);
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
    // A chip's or create item's own press needs its click.
    if (
      event.target instanceof Element &&
      event.target.closest(`[${CHOOSER_ITEM_ATTR}],[${CREATE_ITEM_ATTR}]`)
    ) {
      return;
    }
    suppressClickUntil = 0;
    event.stopPropagation();
    event.preventDefault();
  };

  /**
   * A second finger landed while one was down: every pointer's uncommitted
   * action is cancelled and rolled back, and the pinch or pan (touch events,
   * `timelineZoomGestures.ts`) owns them all until the last one lifts.
   */
  const yieldToMultiTouch = () => {
    const owned = phase;
    setPhase(IDLE);
    gesture.multi = true;
    // No click belongs to a pinch: a finger lifting before the other is not
    // a tap. The window closes once the last finger lifts.
    suppressClickUntil = Number.POSITIVE_INFINITY;
    for (const [pointerId, down] of gesture.pointers) {
      // Each owner cancels on its own pointer's pointercancel, without saving:
      // whatever the finger pressed, and a target the router replayed it on.
      const owners = new Set<Element>();
      if (down.target instanceof Element) owners.add(down.target);
      if (
        (owned.kind === "routed" || owned.kind === "grabbed") &&
        owned.pointerId === pointerId
      ) {
        owners.add(owned.element);
      }
      for (const owner of owners) replayPointer("pointercancel", owner, down);
    }
    gesture.restore?.();
    gesture.restore = null;
  };
  /** Routes every pointer event, applying the multi-pointer rule first. */
  const guard =
    (
      type: "down" | "move" | "up" | "cancel",
      route: (e: PointerEvent) => void,
    ) =>
    (event: PointerEvent) => {
      if (isReplayed(event)) return;
      const { pointers } = gesture;
      if (
        type === "down" &&
        event.pointerType === "touch" &&
        event.target instanceof Node &&
        scope.contains(event.target)
      ) {
        if (pointers.size === 0) gesture.restore = options.snapshot?.() ?? null;
        else if (!gesture.multi) yieldToMultiTouch();
        pointers.set(event.pointerId, event);
      } else if (
        type === "down" &&
        event.pointerType === "touch" &&
        pointers.size > 0 &&
        !pointers.has(event.pointerId) &&
        !gesture.multi
      ) {
        // A second finger off the timeline (on the create menu's scrim, a
        // sheet) still cancels what the first one is doing there.
        yieldToMultiTouch();
      }
      if (gesture.multi && pointers.has(event.pointerId)) {
        event.stopImmediatePropagation();
        if (event.cancelable) event.preventDefault();
        if (type === "up" || type === "cancel") {
          pointers.delete(event.pointerId);
          if (pointers.size === 0) {
            gesture.multi = false;
            suppressClickUntil = Date.now() + GHOST_CLICK_MS;
          }
        }
        return;
      }
      if (type === "up" || type === "cancel") {
        pointers.delete(event.pointerId);
        if (pointers.size === 0) gesture.restore = null;
      }
      route(event);
    };

  const listeners = [
    ["pointerdown", guard("down", onDown)],
    ["pointermove", guard("move", onMove)],
    ["pointerup", guard("up", onUp)],
    ["pointercancel", guard("cancel", onCancel)],
    ["click", onClick],
  ] as const;
  for (const [type, listener] of listeners) {
    doc.addEventListener(type, listener as EventListener, true);
  }

  /** The deferred press, if the finger stayed within the slop. */
  const settle = () => {
    if (phase.kind !== "pressing") return null;
    const press = phase;
    setPhase(IDLE);
    return travel(press.at, press.origin) <= TOUCH_SLOP_PX ? press : null;
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
      if (hits.length === 0) {
        // Empty space: what can be made here.
        phase = {
          kind: "create",
          pointerId: down.pointerId,
          view: { origin, surface: winner, fingerDown: true, over: null },
        };
        emitCreate(phase.view);
        return;
      }
      if (hits.length === 1) {
        const [{ candidate, element }] = hits;
        if (longPressAction(candidate.kind) === "arm") {
          grab(element, down, candidate, origin);
        } else {
          report(element);
          tapOn(element, down, down, candidate);
        }
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
      if (phase.kind !== "open" && phase.kind !== "create") return;
      setPhase(IDLE);
      // A tap outside closes on its press; its click must not reach whatever
      // the chooser or menu was covering.
      suppressClickUntil = Date.now() + GHOST_CLICK_MS;
    },
  };
  return router;
}
