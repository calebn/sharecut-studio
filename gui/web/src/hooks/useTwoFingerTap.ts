import { type RefObject, useEffect } from "react";
import { execute } from "../commands/execute";
import { useDawStore } from "../state/dawStore";

const MAX_TAP_DURATION_MS = 300;
const MAX_SECOND_FINGER_DELAY_MS = 150;
const MAX_CONTACT_MOVEMENT_PX = 24;
const MAX_SEPARATION_CHANGE_PX = 12;
const MAX_ROTATION_RAD = Math.PI / 12;

type Contact = {
  id: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  ended: boolean;
};

type TapState =
  | { kind: "idle" }
  | { kind: "awaiting-second"; firstStartedAt: number; first: Contact }
  | {
      kind: "tracking";
      firstStartedAt: number;
      contacts: Map<number, Contact>;
      initialSeparation: number;
      initialAngle: number;
    }
  | { kind: "cancelled" };

function touchById(touches: TouchList, id: number): Touch | undefined {
  for (let index = 0; index < touches.length; index += 1) {
    if (touches[index].identifier === id) return touches[index];
  }
  return undefined;
}

function contactFrom(touch: Touch): Contact {
  return {
    id: touch.identifier,
    startX: touch.clientX,
    startY: touch.clientY,
    lastX: touch.clientX,
    lastY: touch.clientY,
    ended: false,
  };
}

type Point = Pick<Touch, "clientX" | "clientY">;

function pairGeometry(first: Point, second: Point) {
  const dx = second.clientX - first.clientX;
  const dy = second.clientY - first.clientY;
  return { separation: Math.hypot(dx, dy), angle: Math.atan2(dy, dx) };
}

function angularDifference(first: number, second: number): number {
  return Math.abs(
    Math.atan2(Math.sin(first - second), Math.cos(first - second)),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Recognizes the iOS two-finger Undo tap without competing with timeline
 * gestures. The command bus retains the final availability check.
 */
export function useTwoFingerTap(
  ref: RefObject<HTMLElement | null>,
  options: { enabled: boolean },
): void {
  const { enabled } = options;
  useEffect(() => {
    const element = ref.current;
    if (!element || !enabled) return;

    let state: TapState = { kind: "idle" };
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const clearTapTimeout = () => {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      timeoutId = undefined;
    };
    const resetInteraction = () => {
      clearTapTimeout();
      state = { kind: "idle" };
    };
    const cancelInteraction = () => {
      clearTapTimeout();
      state = { kind: "cancelled" };
    };
    const startTapTimeout = () => {
      clearTapTimeout();
      timeoutId = setTimeout(cancelInteraction, MAX_TAP_DURATION_MS);
    };
    const hasMoved = (contact: Contact, touch: Point) =>
      Math.hypot(
        touch.clientX - contact.startX,
        touch.clientY - contact.startY,
      ) > MAX_CONTACT_MOVEMENT_PX;
    const updateContact = (contact: Contact, touch: Point) => {
      contact.lastX = touch.clientX;
      contact.lastY = touch.clientY;
    };
    const gestureThresholdExceeded = (
      tracking: Extract<TapState, { kind: "tracking" }>,
      touches: TouchList,
      changedTouches?: TouchList,
      allowLastKnown = false,
    ) => {
      const contacts = [...tracking.contacts.values()];
      const points = contacts.map((contact) => {
        const current =
          touchById(touches, contact.id) ??
          (changedTouches ? touchById(changedTouches, contact.id) : undefined);
        if (current) return current;
        return allowLastKnown
          ? { clientX: contact.lastX, clientY: contact.lastY }
          : undefined;
      });
      if (points.some((point) => !point)) return true;
      const [first, second] = points as [Point, Point];
      if (
        contacts.some((contact, index) =>
          hasMoved(contact, points[index] as Point),
        )
      )
        return true;
      const geometry = pairGeometry(first, second);
      return (
        Math.abs(geometry.separation - tracking.initialSeparation) >
          MAX_SEPARATION_CHANGE_PX ||
        angularDifference(geometry.angle, tracking.initialAngle) >
          MAX_ROTATION_RAD
      );
    };
    const reportFailure = (reason: string) => {
      useDawStore.getState().announceStatus(`Undo failed: ${reason}`);
    };
    const undo = () => {
      void execute("history.undo")
        .then((result) => {
          if (result.status !== "ok")
            reportFailure("reason" in result ? result.reason : "unavailable");
        })
        .catch((error: unknown) => reportFailure(errorMessage(error)));
    };

    const onTouchStart = (event: TouchEvent) => {
      if (event.defaultPrevented) {
        cancelInteraction();
        return;
      }
      const now = Date.now();
      if (state.kind === "idle") {
        if (event.touches.length === 1) {
          state = {
            kind: "awaiting-second",
            firstStartedAt: now,
            first: contactFrom(event.touches[0]),
          };
          startTapTimeout();
        } else if (event.touches.length === 2) {
          const [first, second] = [event.touches[0], event.touches[1]];
          const contacts = new Map([
            [first.identifier, contactFrom(first)],
            [second.identifier, contactFrom(second)],
          ]);
          if (contacts.size !== 2) {
            cancelInteraction();
            return;
          }
          const geometry = pairGeometry(first, second);
          state = {
            kind: "tracking",
            firstStartedAt: now,
            contacts,
            initialSeparation: geometry.separation,
            initialAngle: geometry.angle,
          };
          startTapTimeout();
        } else {
          cancelInteraction();
        }
        return;
      }
      if (state.kind !== "awaiting-second" || event.touches.length !== 2) {
        cancelInteraction();
        return;
      }
      const awaitingSecond = state;
      if (now - awaitingSecond.firstStartedAt > MAX_SECOND_FINGER_DELAY_MS) {
        cancelInteraction();
        return;
      }
      const first = touchById(event.touches, awaitingSecond.first.id);
      const second = Array.from(event.touches).find(
        (touch) => touch.identifier !== awaitingSecond.first.id,
      );
      if (!first || !second || hasMoved(awaitingSecond.first, first)) {
        cancelInteraction();
        return;
      }
      updateContact(awaitingSecond.first, first);
      const contacts = new Map([
        [first.identifier, awaitingSecond.first],
        [second.identifier, contactFrom(second)],
      ]);
      const geometry = pairGeometry(first, second);
      state = {
        kind: "tracking",
        firstStartedAt: awaitingSecond.firstStartedAt,
        contacts,
        initialSeparation: geometry.separation,
        initialAngle: geometry.angle,
      };
    };

    const onTouchMove = (event: TouchEvent) => {
      if (event.defaultPrevented) {
        cancelInteraction();
        return;
      }
      if (state.kind !== "tracking") return;
      if (event.touches.length !== 2) {
        cancelInteraction();
        return;
      }
      if (gestureThresholdExceeded(state, event.touches)) {
        cancelInteraction();
        return;
      }
      for (const contact of state.contacts.values()) {
        const touch = touchById(event.touches, contact.id);
        if (touch) updateContact(contact, touch);
      }
    };

    const onTouchEnd = (event: TouchEvent) => {
      if (state.kind === "cancelled" || state.kind === "awaiting-second") {
        if (event.touches.length === 0) resetInteraction();
        return;
      }
      if (state.kind !== "tracking" || event.defaultPrevented) {
        cancelInteraction();
        return;
      }
      if (event.touches.length > 2) {
        cancelInteraction();
        return;
      }
      for (const touch of Array.from(event.touches)) {
        if (!state.contacts.has(touch.identifier)) {
          cancelInteraction();
          return;
        }
      }
      for (const touch of Array.from(event.changedTouches)) {
        const contact = state.contacts.get(touch.identifier);
        if (!contact || hasMoved(contact, touch)) {
          cancelInteraction();
          return;
        }
        updateContact(contact, touch);
        contact.ended = true;
      }
      for (const touch of Array.from(event.touches)) {
        const contact = state.contacts.get(touch.identifier);
        if (contact) updateContact(contact, touch);
      }
      if (
        gestureThresholdExceeded(
          state,
          event.touches,
          event.changedTouches,
          true,
        )
      ) {
        cancelInteraction();
        return;
      }
      for (const contact of state.contacts.values()) {
        if (!touchById(event.touches, contact.id)) contact.ended = true;
      }
      if (![...state.contacts.values()].every((contact) => contact.ended))
        return;

      const duration = Date.now() - state.firstStartedAt;
      resetInteraction();
      if (event.touches.length !== 0 || duration > MAX_TAP_DURATION_MS) return;
      event.preventDefault();
      undo();
    };

    const onTouchCancel = (event: TouchEvent) => {
      cancelInteraction();
      if (event.touches.length === 0) resetInteraction();
    };

    element.addEventListener("touchstart", onTouchStart, { passive: true });
    element.addEventListener("touchmove", onTouchMove, { passive: true });
    element.addEventListener("touchend", onTouchEnd, { passive: false });
    element.addEventListener("touchcancel", onTouchCancel);
    const cleanup = () => {
      clearTapTimeout();
      element.removeEventListener("touchstart", onTouchStart);
      element.removeEventListener("touchmove", onTouchMove);
      element.removeEventListener("touchend", onTouchEnd);
      element.removeEventListener("touchcancel", onTouchCancel);
    };
    return cleanup;
  }, [enabled, ref]);
}
