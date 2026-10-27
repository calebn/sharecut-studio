import type { StageId } from "../../system/verbs";

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

const ROLE_HINT: Record<GuestRole, string> = {
  viewer: "You can listen along. The host decides.",
  commenter: "You can comment and suggest cuts. The host decides.",
  editor: "You can edit and comment. The host decides what ships.",
};

export const roleHint = (role: GuestRole) => ROLE_HINT[role];
