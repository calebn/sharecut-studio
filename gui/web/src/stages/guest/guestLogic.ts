export function lastStartedWordAt(
  wordStarts: readonly (number | null)[],
  seconds: number,
): number | undefined {
  let best: number | undefined;
  wordStarts.forEach((start, index) => {
    if (start === null || start > seconds) return;
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
