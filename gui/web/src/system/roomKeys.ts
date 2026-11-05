import { useSyncExternalStore } from "react";

/**
 * What the keys R, hold R, P, M and C do in the open room. The room view
 * registers its handlers here; the commands read them, so the keymap never
 * reaches into a component. `take` is "idle" with no take open, "live" while
 * a take records or is paused.
 */
export type RoomKeyHandlers = {
  take: "idle" | "live";
  start?: () => void;
  stop?: () => void;
  pause?: () => void;
  mute?: () => void;
  marker?: () => void;
};

let current: RoomKeyHandlers | null = null;
const listeners = new Set<() => void>();

export function setRoomKeys(next: RoomKeyHandlers | null): void {
  current = next;
  for (const l of listeners) l();
}

export function roomKeys(): RoomKeyHandlers | null {
  return current;
}

export function useRoomKeysState(): RoomKeyHandlers | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
