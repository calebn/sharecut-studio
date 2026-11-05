/**
 * The room view registers its key handlers here and the commands read them,
 * so the keymap never reaches into a component. `take` is "idle" with no take
 * open, "live" while a take records or is paused.
 */
export type RoomKeyHandlers = {
  take: "idle" | "live";
  start?: () => void;
  stop?: () => void;
  pause?: () => void;
  mute?: () => void;
};

let current: RoomKeyHandlers | null = null;

export function setRoomKeys(next: RoomKeyHandlers | null): void {
  current = next;
}

export function roomKeys(): RoomKeyHandlers | null {
  return current;
}
