/**
 * The Editor's one-time reminder that an edit changes the host's episode for
 * everyone, raised after the first edit the link applies and kept per link and
 * browser. It shares the role bubble's place in the header; the bubble stays
 * until it is dismissed, so no later status line can replace it.
 */
import { readLocal, writeLocal } from "./storage";

export const EDIT_STAKES_TEXT =
  "You changed the host's episode, and everyone sees it. Undo takes back only your own step.";

/** cyrb53: a sync, deterministic digest, so the link token never reaches storage. */
function digest(token: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < token.length; i++) {
    const c = token.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export const editStakesKey = (token: string) =>
  `sharecut.editStakesSeen.${digest(token)}`;

/** Blocked storage costs a reload, never a repeat in the same session. */
const seenHere = new Set<string>();

/** A page with no link token has nobody to remind. */
export function editStakesSeen(token: string | null): boolean {
  return (
    token === null ||
    seenHere.has(token) ||
    readLocal(editStakesKey(token)) === "1"
  );
}

export function markEditStakesSeen(token: string | null): void {
  if (token === null) return;
  seenHere.add(token);
  writeLocal(editStakesKey(token), "1");
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
