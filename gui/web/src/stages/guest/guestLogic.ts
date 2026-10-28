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

export type GuestEmpty = "none" | "cut" | "unplaced" | "untimed";

export const GUEST_EMPTY_COPY: Record<GuestEmpty, string> = {
  none: "The host has not made a transcript of this version.",
  cut: "Every word of this version has been cut or ignored.",
  unplaced: "The words of this version are not on the timeline yet.",
  untimed: "The transcript of this version has no word timings yet.",
};
