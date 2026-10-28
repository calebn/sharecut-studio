import type { StageId } from "../../types/stage";

export type GuestRole = "viewer" | "commenter" | "editor";

export function guestStages(role: GuestRole): readonly StageId[] | null {
  return role === "editor" ? ["edit", "review"] : null;
}

export const ROLE_HINT: Record<GuestRole, string> = {
  viewer: "You can listen along. The host decides.",
  commenter: "You can comment and suggest cuts. The host decides.",
  editor: "You can edit and comment. The host decides what ships.",
};

export function lastStartedWordAt(
  wordStarts: readonly number[],
  seconds: number,
): number | undefined {
  let best: number | undefined;
  wordStarts.forEach((start, index) => {
    if (start > seconds) return;
    if (best === undefined || start >= (wordStarts[best] ?? 0)) best = index;
  });
  return best;
}
