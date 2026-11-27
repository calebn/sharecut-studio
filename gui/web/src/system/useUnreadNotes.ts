import { useEffect, useState } from "react";
import type { NoteItem } from "./notesRailModel";

/**
 * Which comments the host has had on screen. The caller owns it so a RoomView
 * that remounts (a reconnect) does not turn comments already in the room into
 * new ones.
 */
export class UnreadStore {
  seeded = false;
  private readonly ids = new Set<string>();

  has(id: string): boolean {
    return this.ids.has(id);
  }

  /** The room's comments at load: they were already there, not new. */
  seed(notes: readonly NoteItem[]): void {
    this.markSeen(notes);
    this.seeded = true;
  }

  markSeen(notes: readonly NoteItem[]): void {
    for (const item of notes) this.ids.add(item.id);
  }

  reset(): void {
    this.ids.clear();
    this.seeded = false;
  }
}

const BADGE_CAP = 99;

/** Markers never count, and neither do the host's own. */
function unseenOthers(
  notes: readonly NoteItem[],
  store: UnreadStore,
  selfName: string,
): number {
  let count = 0;
  for (const item of notes) {
    if (item.kind !== "note" || store.has(item.id)) continue;
    if (item.mine ?? item.author.name === selfName) continue;
    count += 1;
  }
  return count;
}

export function unreadBadgeText(count: number): string {
  return count > BADGE_CAP ? `${BADGE_CAP}+` : String(count);
}

type UnreadInput = {
  notes: readonly NoteItem[];
  selfName: string;
  loading: boolean;
  sheetOpen: boolean;
  commentsShowing: boolean;
  /** Without a store nothing is counted. */
  store?: UnreadStore;
};

/**
 * `count` is 0 while the sheet is open. `pulseKey` is non-zero only while the
 * count has risen while the sheet was closed, and changes with each rise.
 */
export function useUnreadNotes({
  notes,
  selfName,
  loading,
  sheetOpen,
  commentsShowing,
  store,
}: UnreadInput): { count: number; pulseKey: number } {
  const active = !loading ? store : undefined;
  const total =
    active?.seeded === true ? unseenOthers(notes, active, selfName) : 0;
  const count = sheetOpen ? 0 : total;

  useEffect(() => {
    if (active && !active.seeded) active.seed(notes);
  }, [active, notes]);

  useEffect(() => {
    if (active && commentsShowing) active.markSeen(notes);
  }, [active, commentsShowing, notes]);

  // Starting from the current total, a remount with unseen comments does not pulse.
  // Adjusted during render, so no committed frame shows a rise without its pulse.
  const [pulse, setPulse] = useState({ previous: total, key: 0 });
  let key = pulse.key;
  if (sheetOpen || total === 0) key = 0;
  else if (total > pulse.previous) key += 1;
  if (key !== pulse.key || total !== pulse.previous) {
    setPulse({ previous: total, key });
  }

  return { count, pulseKey: count > 0 ? key : 0 };
}
