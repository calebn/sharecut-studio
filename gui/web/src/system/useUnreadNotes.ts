import { useEffect, useState } from "react";
import type { NoteItem } from "./notesRailModel";

/**
 * Which comments the host has had on screen. The caller owns it, so a
 * RoomView that remounts (a reconnect) does not turn comments already in the
 * room into new ones.
 */
export class UnreadStore {
  private readonly ids = new Set<string>();
  private seededOnce = false;

  get seeded(): boolean {
    return this.seededOnce;
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  /** The room's comments at load: they were already there, not new. */
  seed(notes: readonly NoteItem[]): void {
    this.markSeen(notes);
    this.seededOnce = true;
  }

  markSeen(notes: readonly NoteItem[]): void {
    for (const item of notes) this.ids.add(item.id);
  }

  reset(): void {
    this.ids.clear();
    this.seededOnce = false;
  }
}

const BADGE_CAP = 99;

/**
 * Comments by someone else that the host has not seen. Markers never count,
 * and neither do the host's own: `mine` when the row says, else the name.
 */
export function unseenOthers(
  notes: readonly NoteItem[],
  seen: Pick<UnreadStore, "has">,
  selfName: string,
): number {
  let count = 0;
  for (const item of notes) {
    if (item.kind !== "note" || seen.has(item.id)) continue;
    if (item.mine ?? item.author.name === selfName) continue;
    count += 1;
  }
  return count;
}

export function unreadBadgeText(count: number): string {
  return count > BADGE_CAP ? `${BADGE_CAP}+` : String(count);
}

/**
 * Said after the badge's number so the peek button's name still contains its
 * visible text ("... 12 unread"). The badge is the only carrier of the count.
 */
export const UNREAD_WORD = " unread";

type UnreadInput = {
  notes: readonly NoteItem[];
  selfName: string;
  /** Off for every seat but a host on a phone. */
  enabled: boolean;
  /** Nothing is seeded or counted until the room has loaded. */
  loading: boolean;
  sheetOpen: boolean;
  /** The sheet is open on the Comments tab: the host is reading comments. */
  commentsShowing: boolean;
  store: UnreadStore;
};

/**
 * The count for the peek bar's badge and a key that changes when it should
 * pulse. `count` is 0 while the sheet is open. `pulseKey` is 0 unless the
 * count just rose while the sheet was closed.
 */
export function useUnreadNotes({
  notes,
  selfName,
  enabled,
  loading,
  sheetOpen,
  commentsShowing,
  store,
}: UnreadInput): { count: number; pulseKey: number } {
  const ready = enabled && !loading;
  const total =
    ready && store.seeded ? unseenOthers(notes, store, selfName) : 0;
  const count = sheetOpen ? 0 : total;

  useEffect(() => {
    if (!ready || store.seeded) return;
    store.seed(notes);
  }, [ready, notes, store]);

  useEffect(() => {
    if (!ready || !commentsShowing) return;
    store.markSeen(notes);
  }, [ready, commentsShowing, notes, store]);

  // Adjusted during render, so no committed frame shows a rise without its pulse.
  const [pulse, setPulse] = useState({ previous: 0, key: 0, active: false });
  let now = pulse;
  if (total > pulse.previous && !sheetOpen) {
    now = { previous: total, key: pulse.key + 1, active: true };
  } else if (
    total !== pulse.previous ||
    (pulse.active && (sheetOpen || !total))
  ) {
    now = {
      previous: total,
      key: pulse.key,
      active: pulse.active && !sheetOpen && total > 0,
    };
  }
  if (now !== pulse) setPulse(now);

  return { count, pulseKey: count > 0 && now.active ? now.key : 0 };
}
