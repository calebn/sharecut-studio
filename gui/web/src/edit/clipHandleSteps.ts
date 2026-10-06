/**
 * Nudge steps for a clip's fade and trim handles: an arrow key moves a focused
 * handle one `small` step (Shift: one `large` step), and the phone peek
 * strip's buttons step by the same amounts.
 */
export const CLIP_HANDLE_STEPS = {
  fade: { small: 1, large: 10, unit: "ms" },
  trim: { small: 0.01, large: 0.1, unit: "s" },
} as const;

export type ClipHandleStepKind = keyof typeof CLIP_HANDLE_STEPS;
