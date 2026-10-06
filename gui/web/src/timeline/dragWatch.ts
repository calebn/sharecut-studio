/**
 * Reports when a timeline drag starts and ends, so the phone inspector can get
 * out of its way (#1051 round 3). A drag is a pointer that came down inside
 * `root`, is captured by an element there (every timeline drag owner captures
 * its pointer), and has travelled `HANDLE_DRAG_MIN_PX`. Its release, cancel or
 * lost capture ends it. A scroll never counts: nothing captured that finger.
 *
 * A press the hit router replayed is measured in the target's coordinates,
 * so its pointer counts only the router's replayed moves, not the finger's.
 * The router replays moves only for a target it grabbed, so a replayed move
 * is a drag even where the owner could not capture the pointer.
 */
import { HANDLE_DRAG_MIN_PX } from "../hooks/gestureConstants";
import { isReplayed } from "./hitRouting";

export function attachDragWatch(
  root: Element,
  onChange: (dragging: boolean) => void,
): () => void {
  const doc = root.ownerDocument;
  const downs = new Map<number, { x: number; y: number; replayed: boolean }>();
  let dragging: number | null = null;

  const onDown = (event: PointerEvent) => {
    if (event.target instanceof Node && root.contains(event.target)) {
      downs.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
        replayed: isReplayed(event),
      });
    }
  };
  const onMove = (event: PointerEvent) => {
    const down = downs.get(event.pointerId);
    const target = event.target;
    if (
      dragging != null ||
      !down ||
      down.replayed !== isReplayed(event) ||
      !(target instanceof Element) ||
      !root.contains(target) ||
      !(isReplayed(event) || target.hasPointerCapture?.(event.pointerId)) ||
      Math.hypot(event.clientX - down.x, event.clientY - down.y) <
        HANDLE_DRAG_MIN_PX
    ) {
      return;
    }
    dragging = event.pointerId;
    onChange(true);
  };
  const onEnd = (event: PointerEvent) => {
    downs.delete(event.pointerId);
    if (dragging !== event.pointerId) return;
    dragging = null;
    onChange(false);
  };

  const listeners = [
    ["pointerdown", onDown],
    ["pointermove", onMove],
    ["pointerup", onEnd],
    ["pointercancel", onEnd],
    ["lostpointercapture", onEnd],
  ] as const;
  for (const [type, listener] of listeners) {
    doc.addEventListener(type, listener as EventListener, true);
  }
  return () => {
    for (const [type, listener] of listeners) {
      doc.removeEventListener(type, listener as EventListener, true);
    }
    if (dragging != null) onChange(false);
  };
}
