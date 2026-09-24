import { isTypingTarget } from "../keymap/typing";
import { wheelZoomFactor } from "../utils/zoom";

export type TimelineZoomHandlers = {
  getZoom: () => number;
  applyZoomAt: (nextZoom: number, clientX: number) => void;
  onZoomClaimed?: () => void;
};

/** Trackpad pinch and Ctrl/Cmd+wheel are encoded as wheel events with a modifier. */
export function isZoomWheelEvent(
  e: Pick<WheelEvent, "ctrlKey" | "metaKey">,
): boolean {
  return e.ctrlKey || e.metaKey;
}

export type PointerOverTimelineInput = {
  el: HTMLElement;
  clientX: number;
  clientY: number;
  eventTarget?: EventTarget | null;
  /** A region inside `el` that never claims zoom (the track headers). */
  exclude?: Element | null;
};

/** Inside `el` and not inside `exclude`. */
export function isPointerOverTimeline({
  el,
  clientX,
  clientY,
  eventTarget,
  exclude,
}: PointerOverTimelineInput): boolean {
  const inside = (node: Node) =>
    el.contains(node) && !(exclude?.contains(node) ?? false);
  if (
    typeof document !== "undefined" &&
    typeof document.elementFromPoint === "function"
  ) {
    const hit = document.elementFromPoint(clientX, clientY);
    if (hit instanceof Node) {
      return inside(hit);
    }
    // elementFromPoint null/odd during some gesture frames — fall through.
  }
  return eventTarget instanceof Node && inside(eventTarget);
}

export type ClaimTimelineZoomInput = PointerOverTimelineInput & {
  activeElement?: EventTarget | null;
};

/** Spatial hit-test + typing guard — do not require prior timelineFocused. */
export function shouldClaimTimelineZoom(
  input: ClaimTimelineZoomInput,
): boolean {
  const active =
    input.activeElement ??
    (typeof document !== "undefined" ? document.activeElement : null);
  if (isTypingTarget(active)) {
    return false;
  }
  return isPointerOverTimeline(input);
}

type SafariGestureEvent = Event & {
  scale: number;
  clientX: number;
  clientY: number;
};

function isIosDevice(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) {
    return true;
  }
  // iPadOS reports as MacIntel but has touch.
  return navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
}

function supportsSafariGestureEvents(): boolean {
  return (
    typeof window !== "undefined" && "GestureEvent" in window && !isIosDevice()
  );
}

export type TimelineZoomOptions = {
  /** Read at event time: a region inside `el` that never claims zoom. */
  exclude?: () => Element | null;
};

/**
 * Attach non-passive wheel / touch / Safari gesture listeners so preventDefault
 * can claim pinch-zoom for the timeline instead of browser page zoom.
 * Listeners attach to `el` (usually `.timeline-scroll`) and claim anywhere in
 * it except `options.exclude()` (the track headers, so mute/solo and reorder
 * never zoom). Returns a disposer.
 */
export function attachTimelineZoomGestures(
  el: HTMLElement,
  handlers: TimelineZoomHandlers,
  options: TimelineZoomOptions = {},
): () => void {
  let pinch: { dist: number; zoom: number } | null = null;
  let safariGesture: { zoom: number; clientX: number } | null = null;
  const claims = (
    clientX: number,
    clientY: number,
    eventTarget: EventTarget | null,
  ) =>
    shouldClaimTimelineZoom({
      el,
      exclude: options.exclude?.() ?? null,
      clientX,
      clientY,
      eventTarget,
    });

  const onWheel = (e: WheelEvent) => {
    if (!isZoomWheelEvent(e)) {
      return;
    }
    // Safari 15+ also emits wheel+ctrl during GestureEvent; avoid double zoom.
    if (safariGesture) {
      e.preventDefault();
      return;
    }
    if (!claims(e.clientX, e.clientY, e.target)) {
      return;
    }
    e.preventDefault();
    handlers.applyZoomAt(
      handlers.getZoom() * wheelZoomFactor(e.deltaY),
      e.clientX,
    );
    handlers.onZoomClaimed?.();
  };

  const onTouchStart = (e: TouchEvent) => {
    if (e.touches.length !== 2) {
      return;
    }
    const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
    const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    if (!claims(midX, midY, e.target)) {
      pinch = null;
      return;
    }
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    pinch = {
      dist: Math.hypot(dx, dy),
      zoom: handlers.getZoom(),
    };
  };

  const onTouchMove = (e: TouchEvent) => {
    if (e.touches.length !== 2 || !pinch) {
      return;
    }
    const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
    const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    if (!claims(midX, midY, e.target)) {
      return;
    }
    e.preventDefault();
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    const dist = Math.hypot(dx, dy);
    const scale = dist / Math.max(1, pinch.dist);
    handlers.applyZoomAt(pinch.zoom * scale, midX);
    handlers.onZoomClaimed?.();
  };

  const onTouchEnd = () => {
    pinch = null;
  };

  const onGestureStart = (e: Event) => {
    const ge = e as SafariGestureEvent;
    if (!claims(ge.clientX, ge.clientY, e.target)) {
      safariGesture = null;
      return;
    }
    e.preventDefault();
    safariGesture = {
      zoom: handlers.getZoom(),
      clientX: ge.clientX,
    };
  };

  const onGestureChange = (e: Event) => {
    const ge = e as SafariGestureEvent;
    if (!safariGesture) {
      return;
    }
    e.preventDefault();
    handlers.applyZoomAt(safariGesture.zoom * ge.scale, safariGesture.clientX);
    handlers.onZoomClaimed?.();
  };

  const onGestureEnd = (e: Event) => {
    if (safariGesture) {
      e.preventDefault();
    }
    safariGesture = null;
  };

  const passiveFalse: AddEventListenerOptions = { passive: false };
  el.addEventListener("wheel", onWheel, passiveFalse);
  el.addEventListener("touchstart", onTouchStart, passiveFalse);
  el.addEventListener("touchmove", onTouchMove, passiveFalse);
  el.addEventListener("touchend", onTouchEnd);
  el.addEventListener("touchcancel", onTouchEnd);

  const useSafariGestures = supportsSafariGestureEvents();
  if (useSafariGestures) {
    el.addEventListener("gesturestart", onGestureStart, passiveFalse);
    el.addEventListener("gesturechange", onGestureChange, passiveFalse);
    el.addEventListener("gestureend", onGestureEnd, passiveFalse);
  }

  return () => {
    el.removeEventListener("wheel", onWheel);
    el.removeEventListener("touchstart", onTouchStart);
    el.removeEventListener("touchmove", onTouchMove);
    el.removeEventListener("touchend", onTouchEnd);
    el.removeEventListener("touchcancel", onTouchEnd);
    if (useSafariGestures) {
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
      el.removeEventListener("gestureend", onGestureEnd);
    }
  };
}
