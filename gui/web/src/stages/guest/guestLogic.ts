import type { StageId } from "../../system/verbs";
import { capCommentName, GUEST_SESSION_LABEL } from "../../utils/commentAuthor";

export type GuestRole = "viewer" | "commenter" | "editor";

/** Only an editor has a Stage bar: Edit and Review. Everyone else gets Review alone, with no bar. */
export function guestStages(role: GuestRole): readonly StageId[] | null {
  return role === "editor" ? ["edit", "review"] : null;
}

export const canComment = (role: GuestRole) => role !== "viewer";

/** The word being spoken at `seconds`: the last one that started by then. `starts` is ascending, one per word index. */
export function wordAtSeconds(
  starts: readonly number[],
  seconds: number,
): number | undefined {
  let low = 0;
  let high = starts.length - 1;
  let found: number | undefined;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if ((starts[mid] ?? Infinity) <= seconds) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/** `pinnedAt` null: the chip follows the playhead. A number: the comment stays at that time. */
export type ComposerAnchor = { pinnedAt: number | null };

/** The first keystroke pins the time the guest started typing at; clearing the field lets it follow again. */
export function anchorAfterTyping(
  anchor: ComposerAnchor,
  body: string,
  playhead: number,
): ComposerAnchor {
  if (body.trim() === "") return { pinnedAt: null };
  return anchor.pinnedAt === null ? { pinnedAt: playhead } : anchor;
}

/** Pressing the chip moves a pinned comment to where the playhead is now. */
export function reanchor(
  anchor: ComposerAnchor,
  playhead: number,
): ComposerAnchor {
  return anchor.pinnedAt === null ? anchor : { pinnedAt: playhead };
}

export const anchorSeconds = (anchor: ComposerAnchor, playhead: number) =>
  anchor.pinnedAt ?? playhead;

/** Enter posts; Shift+Enter is a newline, and Enter while composing text is the input method's. */
export function isPostKey(event: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
}): boolean {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing;
}

/** A blank name posts as Guest. */
export const postedName = (name: string) =>
  capCommentName(name) || GUEST_SESSION_LABEL;
