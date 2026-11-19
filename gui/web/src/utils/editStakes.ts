/**
 * The Editor's one-time reminder that an edit changes the host's episode for
 * everyone, raised after the first edit the link applies and kept per link and
 * browser. It shares the role bubble's place in the header; the bubble stays
 * until it is dismissed, so no later status line can replace it.
 */
import { readLocal, writeLocal } from "./storage";

export const EDIT_STAKES_TEXT =
  "You changed the host's episode, and everyone sees it. Undo takes back only your own step.";

const key = (token: string) => `sharecut.editStakesSeen.${token}`;

/** Blocked storage costs a reload, never a repeat in the same session. */
const seenHere = new Set<string>();

/** A page with no link token has nobody to remind. */
export function editStakesSeen(token: string | null): boolean {
  return token === null || seenHere.has(token) || readLocal(key(token)) === "1";
}

export function markEditStakesSeen(token: string | null): void {
  if (token === null) return;
  seenHere.add(token);
  writeLocal(key(token), "1");
}

let up = false;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

export function subscribeEditStakes(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function editStakesUp(): boolean {
  return up;
}

export function raiseEditStakes(token: string | null): void {
  if (up || editStakesSeen(token)) return;
  up = true;
  emit();
}

export function dismissEditStakes(): void {
  if (!up) return;
  up = false;
  emit();
}

export function resetEditStakesForTests(): void {
  seenHere.clear();
  up = false;
  emit();
}
