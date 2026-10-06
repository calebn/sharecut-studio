/**
 * Routes timeline `pointerdown` through the hit resolver (#1051). When the
 * pointer lands on a marked target and more than one target is in reach, the
 * resolver's winner gets the press instead of whatever CSS painted on top:
 * the original event stops at the document and an identical press is
 * replayed on the winner, so its own handlers (capture, drag, commit) run
 * unchanged. One target in reach, or a press on a plain surface, passes
 * through untouched.
 */
import { HANDLE_DRAG_MIN_PX } from "../edit/dragThreshold";
import { GHOST_CLICK_MS } from "../hooks/touchGestureTiming";
import type { HitPoint } from "./hitCandidates";
import { closestHitTarget, resolveHits } from "./hitTargets";

const replayed = new WeakSet<Event>();

/** True for an event this module dispatched. */
export function isReplayed(event: Event): boolean {
  return replayed.has(event);
}

function pointOf(event: PointerEvent): HitPoint {
  return { x: event.clientX, y: event.clientY };
}

/** Dispatches a copy of `source` as `pointerdown` on `element`. */
function replayDown(element: Element, source: PointerEvent): void {
  const event = new PointerEvent("pointerdown", {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerId: source.pointerId,
    pointerType: source.pointerType,
    isPrimary: source.isPrimary,
    width: source.width,
    height: source.height,
    pressure: source.pressure,
    clientX: source.clientX,
    clientY: source.clientY,
    screenX: source.screenX,
    screenY: source.screenY,
    button: source.button,
    buttons: source.buttons,
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

/** A press the router replayed elsewhere, followed until it lifts. */
type Routed = {
  pointerId: number;
  element: Element;
  origin: HitPoint;
  moved: boolean;
};

/**
 * Installs the router on `root` (the marker lane plus the lanes). Listens at
 * the document in the capture phase so the original press never reaches
 * React. Returns the teardown.
 */
export function attachHitRouting(root: Element): () => void {
  const doc = root.ownerDocument;
  let routed: Routed | null = null;
  let suppressClickUntil = 0;

  // A touch that began on a scrollable surface would otherwise pan the
  // timeline (and cancel the pointer) once it moves.
  const blockScroll = (event: TouchEvent) => {
    if (event.cancelable) event.preventDefault();
  };
  const endRouted = () => {
    routed = null;
    doc.removeEventListener("touchmove", blockScroll);
  };

  const onDown = (event: PointerEvent) => {
    if (
      isReplayed(event) ||
      routed ||
      !(event.target instanceof Node) ||
      !root.contains(event.target)
    ) {
      return;
    }
    const hit = closestHitTarget(event.target);
    if (!hit) {
      return;
    }
    const hits = resolveHits(root, pointOf(event), event.pointerType, hit);
    const winner = hits[0]?.element;
    if (hits.length < 2 || !winner || winner === hit) {
      return;
    }
    event.stopPropagation();
    event.preventDefault();
    routed = {
      pointerId: event.pointerId,
      element: winner,
      origin: pointOf(event),
      moved: false,
    };
    if (event.pointerType === "touch") {
      doc.addEventListener("touchmove", blockScroll, { passive: false });
    }
    replayDown(winner, event);
  };

  const onMove = (event: PointerEvent) => {
    if (routed?.pointerId !== event.pointerId || isReplayed(event)) return;
    if (
      Math.hypot(
        event.clientX - routed.origin.x,
        event.clientY - routed.origin.y,
      ) >= HANDLE_DRAG_MIN_PX
    ) {
      routed.moved = true;
    }
  };

  const onUp = (event: PointerEvent) => {
    if (routed?.pointerId !== event.pointerId || isReplayed(event)) return;
    const { element, moved } = routed;
    endRouted();
    // The browser's click lands on whatever the original press hit; the
    // winner gets the click a tap on it would have produced instead.
    suppressClickUntil = Date.now() + GHOST_CLICK_MS;
    if (!moved) {
      const at = pointOf(event);
      setTimeout(() => replayClick(element, event, at), 0);
    }
  };

  const onCancel = (event: PointerEvent) => {
    if (routed?.pointerId === event.pointerId && !isReplayed(event)) {
      endRouted();
    }
  };

  const onClick = (event: MouseEvent) => {
    if (isReplayed(event) || Date.now() >= suppressClickUntil) return;
    suppressClickUntil = 0;
    event.stopPropagation();
    event.preventDefault();
  };

  doc.addEventListener("pointerdown", onDown, true);
  doc.addEventListener("pointermove", onMove, true);
  doc.addEventListener("pointerup", onUp, true);
  doc.addEventListener("pointercancel", onCancel, true);
  doc.addEventListener("click", onClick, true);
  return () => {
    endRouted();
    doc.removeEventListener("pointerdown", onDown, true);
    doc.removeEventListener("pointermove", onMove, true);
    doc.removeEventListener("pointerup", onUp, true);
    doc.removeEventListener("pointercancel", onCancel, true);
    doc.removeEventListener("click", onClick, true);
  };
}
