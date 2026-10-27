/**
 * The Notes rail's rows: markers and text notes in the order they were made on
 * the recording clock. Pure, so the rail, its stories and its tests share one
 * set of rules about who sees what.
 */

export type NoteKind = "marker" | "note";
/** "hosts" is host and producers; guests never see it unless they wrote it. */
export type NoteVisibility = "everyone" | "hosts";
export type NoteViewer = "host" | "producer" | "guest";

export type NoteItem = {
  id: string;
  kind: NoteKind;
  author: { name: string; colorIndex?: number };
  /** The typed words. Markers carry none. */
  text?: string;
  /** "12:04" on the recording clock. Null for a session-level note. */
  time: string | null;
  /**
   * Notes only. Visibility applies to text notes; a marker is always shown to
   * everyone, so markers carry none.
   */
  visibility?: NoteVisibility;
};

/** What the composer hands to `onSend`. */
export type NoteDraft = {
  text: string;
  time: string | null;
  everyone: boolean;
};

const CLOCK = /^\d+(?::\d{1,2}){1,2}$/;

/** Seconds for "12:04" or "1:02:03". Anything else has no place on the clock. */
function clockSeconds(time: string): number {
  if (!CLOCK.test(time)) return Number.POSITIVE_INFINITY;
  return time.split(":").reduce((total, part) => total * 60 + Number(part), 0);
}

/**
 * Chronological: a session-level note (no time) lands at the session start, so
 * it sorts first. Equal times fall back to the id, which keeps the order
 * deterministic when two notes share a second.
 */
export function sortNotes(items: readonly NoteItem[]): NoteItem[] {
  return [...items].sort((a, b) => {
    const byTime = compareTime(a.time, b.time);
    if (byTime !== 0) return byTime;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function compareTime(a: string | null, b: string | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1;
  const left = clockSeconds(a);
  const right = clockSeconds(b);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Hosts and producers see every row. A guest sees the markers, the notes sent
 * to everyone, and their own notes. Hosts-only notes stay out of a guest's list
 * so the guest never sees a row they cannot act on.
 */
export function visibleNotes(
  items: readonly NoteItem[],
  viewer: NoteViewer,
  selfName: string,
): NoteItem[] {
  if (viewer !== "guest") return [...items];
  const self = selfName.trim();
  return items.filter(
    (item) =>
      item.kind === "marker" ||
      item.visibility === "everyone" ||
      (self !== "" && item.author.name.trim() === self),
  );
}

/** A hosts-only text note: its row carries the lock. Markers are never restricted. */
export function isRestrictedNote(item: NoteItem): boolean {
  return item.kind === "note" && item.visibility === "hosts";
}

/** The row's one line. A marker says so; a note is its text. */
export function noteSnippet(item: NoteItem): string {
  return item.kind === "marker" ? "Marker" : (item.text ?? "").trim();
}

/** Send stays off until the draft has a word that is not only spaces. */
export function canSendNote(draft: string): boolean {
  return draft.trim().length > 0;
}
