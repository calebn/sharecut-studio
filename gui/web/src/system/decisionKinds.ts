import type { SystemIconName } from "./icons";
import type { VerbId } from "./verbs";

export type DecisionKind =
  | "check"
  | "unsure-word"
  | "comment"
  | "filler"
  | "pause"
  | "repeat"
  | "false-start"
  | "sound"
  | "suggestion";

export type DecisionKindMeta = {
  readonly label: string;
  readonly icon: SystemIconName;
  readonly verb: VerbId;
  /** The word on the primary button when it differs from the verb label. */
  readonly verbLabel?: string;
  /** Changes audio, so the card may draw a waveform when the content has one. */
  readonly wave: boolean;
};

export const KIND_META: Readonly<Record<DecisionKind, DecisionKindMeta>> = {
  check: {
    label: "Check",
    icon: "triangle-alert",
    verb: "approve",
    wave: false,
  },
  "unsure-word": {
    label: "Unsure word",
    icon: "circle-help",
    verb: "approve",
    verbLabel: "Looks right",
    wave: false,
  },
  comment: {
    label: "Comment",
    icon: "message-square",
    verb: "resolve",
    wave: false,
  },
  filler: { label: "Filler", icon: "scissors", verb: "cut", wave: true },
  pause: {
    label: "Pause",
    icon: "fold-horizontal",
    verb: "shorten",
    wave: true,
  },
  repeat: { label: "Repeat", icon: "copy", verb: "cut", wave: true },
  "false-start": {
    label: "False start",
    icon: "undo-2",
    verb: "cut",
    wave: true,
  },
  sound: { label: "Sound", icon: "volume-1", verb: "lower", wave: true },
  suggestion: { label: "Suggestion", icon: "replace", verb: "cut", wave: true },
};
