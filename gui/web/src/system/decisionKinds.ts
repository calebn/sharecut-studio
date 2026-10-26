import type { SystemIconName } from "./icons";
import type { VerbId } from "./verbs";

export type DecisionKind =
  | "check"
  | "unsure-word"
  | "comment"
  | "filler"
  | "pause"
  | "sound";

/** Kinds that change audio and so draw a waveform. */
export type WaveKind = "filler" | "pause" | "sound";

export const isWaveKind = (kind: DecisionKind): kind is WaveKind =>
  kind === "filler" || kind === "pause" || kind === "sound";

export type DecisionKindMeta = {
  readonly label: string;
  readonly icon: SystemIconName;
  readonly verb: VerbId;
  /** The word on the primary button when it differs from the verb label. */
  readonly verbLabel?: string;
};

export const KIND_META: Readonly<Record<DecisionKind, DecisionKindMeta>> = {
  check: { label: "Check", icon: "triangle-alert", verb: "approve" },
  "unsure-word": {
    label: "Unsure word",
    icon: "circle-help",
    verb: "approve",
    verbLabel: "Looks right",
  },
  comment: { label: "Comment", icon: "message-square", verb: "resolve" },
  filler: { label: "Filler", icon: "scissors", verb: "cut" },
  pause: { label: "Pause", icon: "fold-horizontal", verb: "shorten" },
  sound: { label: "Sound", icon: "volume-1", verb: "lower" },
};
