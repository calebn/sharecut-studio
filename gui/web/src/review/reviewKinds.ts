import type { SystemIconName } from "../system/icons";
import type { VerbId } from "../system/verbs";

/** Queue order: Checks first, then Comments, then suggestion kinds. */
export const REVIEW_KINDS = [
  "check",
  "unsure-word",
  "comment",
  "filler",
  "pause",
  "sound",
] as const;

export type ReviewKind = (typeof REVIEW_KINDS)[number];

export type ReviewKindMeta = {
  readonly label: string;
  readonly plural: string;
  readonly icon: SystemIconName;
  /** The kind's primary verb, from the verb table. */
  readonly verb: VerbId;
  /** The word on the primary button when it differs from the verb label. */
  readonly verbLabel?: string;
  /** Whether the kind's group may offer a bulk verb. */
  readonly bulk: boolean;
};

export const KIND_META = {
  check: {
    label: "Check",
    plural: "Checks",
    icon: "triangle-alert",
    verb: "approve",
    bulk: false,
  },
  "unsure-word": {
    label: "Unsure word",
    plural: "Unsure words",
    icon: "circle-help",
    verb: "approve",
    verbLabel: "Looks right",
    bulk: false,
  },
  comment: {
    label: "Comment",
    plural: "Comments",
    icon: "message-square",
    verb: "resolve",
    bulk: false,
  },
  filler: {
    label: "Filler",
    plural: "Fillers",
    icon: "scissors",
    verb: "cut",
    bulk: true,
  },
  pause: {
    label: "Pause",
    plural: "Pauses",
    icon: "fold-horizontal",
    verb: "shorten",
    bulk: true,
  },
  sound: {
    label: "Sound",
    plural: "Sounds",
    icon: "volume-1",
    verb: "lower",
    bulk: true,
  },
} as const satisfies Record<ReviewKind, ReviewKindMeta>;
