import type { SystemIconName } from "../../system/icons";

/** The kinds of object a press can land on: Edit's own vocabulary, mapped by the host from its hits. */
export type ChooserKind =
  | "clip"
  | "seam"
  | "comment"
  | "suggestion"
  | "envelope-point"
  | "chapter"
  | "social-clip"
  | "word";

/** The attribute the host reads to find the chip under a sliding finger. */
export const TARGET_ID_ATTR = "data-target-id";

export const KIND_ICONS: Record<ChooserKind, SystemIconName> = {
  clip: "audio-waveform",
  seam: "blend",
  comment: "message-square",
  suggestion: "wand-sparkles",
  "envelope-point": "spline",
  chapter: "flag",
  "social-clip": "brackets",
  word: "text-cursor-input",
};

export const KIND_NAMES: Record<ChooserKind, string> = {
  clip: "Clip",
  seam: "Seam",
  comment: "Comment",
  suggestion: "Suggestion",
  "envelope-point": "Envelope point",
  chapter: "Chapter",
  "social-clip": "Social clip",
  word: "Word",
};
