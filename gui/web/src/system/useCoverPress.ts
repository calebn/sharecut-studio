import { useState } from "react";
import { HELD_BUSY_MS, useHeldBusy } from "./useHeldBusy";

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
 */
export function useCoverPress({
  key,
  trying,
  stillFailing,
  changed,
}: {
  key: string;
  trying: boolean;
  stillFailing: string;
  changed: string;
}): { busy: boolean; status: string; press: () => void } {
  const held = useHeldBusy(trying, HELD_BUSY_MS);
  const [pressedKey, setPressedKey] = useState<string | null>(null);
  const { busy } = held;

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
