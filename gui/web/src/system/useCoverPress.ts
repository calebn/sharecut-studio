import { type RefObject, useEffect, useState } from "react";
import { HELD_BUSY_MS, useHeldBusy } from "./useHeldBusy";

/** What the retry button says while a press is being answered. */
export const TRYING_LABEL = "Trying…";

/** The `actionId` a cover gives its retry button, so focus can follow it. */
export const RETRY_ACTION = "retry";

/**
 * How a cover answers a press on its retry button, the same on every cover a
 * guest meets: the button reads busy (for at least `HELD_BUSY_MS`), a polite
 * status line says "Trying again…" and then what came of it. `key` is what
 * makes two failures "the same cover" (the title, or a kind that several
 * covers share a title across); `trying` is any attempt in flight, pressed
 * or not.
 *
 * "Still …" is true only while the cover is the one that was pressed. A press
 * answered by a different cover says what that cover is, since focus stays on
 * the button and this line is all a screen reader hears.
 *
 * Focus follows the press: when a different cover answers, it stays on the
 * retry button if the new cover still has one (wherever it sits), else moves
 * to the new cover's title. A cover that changes without a press moves nothing.
 */
export function useCoverPress({
  key,
  trying,
  stillFailing,
  changed,
  scope,
  title,
}: {
  key: string;
  trying: boolean;
  stillFailing: string;
  changed: string;
  /** The element that holds the cover, to find its retry button in. */
  scope: RefObject<HTMLElement | null>;
  /** The cover's title element. */
  title: RefObject<HTMLElement | null>;
}): { busy: boolean; status: string; press: () => void } {
  const held = useHeldBusy(trying, HELD_BUSY_MS);
  const [pressedKey, setPressedKey] = useState<string | null>(null);
  const { busy } = held;
  useEffect(() => {
    if (pressedKey === null || busy) return;
    const active = document.activeElement;
    const lost = !active || active === document.body;
    // Focus the person moved elsewhere in the meantime is theirs to keep.
    if (!lost && !scope.current?.contains(active)) return;
    if (pressedKey === key && !lost) return;
    const retry = scope.current?.querySelector<HTMLElement>(
      `[data-cover-action="${RETRY_ACTION}"]`,
    );
    (retry ?? title.current)?.focus();
  }, [key, busy, pressedKey, scope, title]);

  // The status speaks only about the press it answers: an attempt nobody
  // pressed starting forgets it.
  if (pressedKey !== null && trying && !busy) {
    setPressedKey(null);
  }
  const answer = pressedKey === key ? stillFailing : changed;
  const status = busy ? "Trying again…" : pressedKey !== null ? answer : "";
  return {
    busy,
    status,
    press: () => {
      held.press();
      setPressedKey(key);
    },
  };
}
