import type {
  EditFacts,
  EditKind,
  PendingSuggestedAction,
} from "../edit/editSelection";
import type { SystemIconName } from "./icons";
import { ariaShortcutOf, hintOf, verbOf } from "./verbDisplay";
import { VERBS, type VerbId } from "./verbs";

export type MoreCommandId =
  | "paste"
  | "copy"
  | "moveTrackUp"
  | "moveTrackDown"
  | "smoothJoins"
  | "moveToSpeaker"
  | "fillRoomTone"
  | "gain"
  | "fade"
  | "moveToTrack"
  | "adjustBounds"
  | "seek";

export type SegmentedBarId = "joinType";

/** `paste` is the one command that sits in the bar itself, on the playhead. */
export type BarId = VerbId | MoreCommandId | SegmentedBarId;

export type MoreRowId = MoreCommandId | "mute";

export type Guard = "holdsCut" | "hasGap" | "host" | "clipboardHasAudio";

type Rule<Id> = { readonly id: Id; readonly when?: Guard };

export type ActionSet = {
  readonly bar: readonly Rule<BarId>[];
  readonly more: readonly Rule<MoreRowId>[];
};

/** Design-system element 7 order, with the ids it leaves unplaced put where every set reads in spec order. */
export const EDIT_ORDER: readonly BarId[] = [
  "hear",
  "joinType",
  "hearBefore",
  "hearAfter",
  "keep",
  "split",
  "addChapter",
  "comment",
  "fixText",
  "record",
  "paste",
  "export",
  "cut",
  "remove",
  "more",
  "inspect",
];

const READ_ONLY_BAR: readonly BarId[] = ["hear", "comment"];
const READ_ONLY_WORD_BAR: readonly BarId[] = ["hear", "comment", "more"];
const READ_ONLY_WORD_MORE: readonly MoreRowId[] = ["copy"];

const bar = (id: BarId, when?: Guard): Rule<BarId> => ({ id, when });
const row = (id: MoreRowId, when?: Guard): Rule<MoreRowId> => ({ id, when });

export const ACTION_SETS: Readonly<Record<EditKind, ActionSet>> = {
  playhead: {
    bar: [
      bar("split"),
      bar("addChapter"),
      bar("record", "host"),
      bar("paste", "clipboardHasAudio"),
    ],
    more: [],
  },
  words: {
    bar: [
      bar("hear"),
      bar("keep", "holdsCut"),
      bar("split"),
      bar("comment"),
      bar("fixText"),
      bar("record", "host"),
      bar("more"),
      bar("inspect"),
    ],
    more: [row("mute"), row("moveToSpeaker"), row("copy")],
  },
  range: {
    bar: [
      bar("hear"),
      bar("split"),
      bar("comment"),
      bar("record", "host"),
      bar("export"),
      bar("more"),
      bar("inspect"),
    ],
    more: [
      row("mute"),
      row("fillRoomTone", "hasGap"),
      row("moveToSpeaker"),
      row("copy"),
    ],
  },
  clip: {
    bar: [
      bar("hear"),
      bar("split"),
      bar("comment"),
      bar("cut"),
      bar("more"),
      bar("inspect"),
    ],
    more: [row("mute"), row("gain"), row("fade"), row("moveToTrack")],
  },
  seam: {
    bar: [
      bar("hear"),
      bar("joinType"),
      bar("keep", "holdsCut"),
      bar("comment"),
      bar("inspect"),
    ],
    more: [],
  },
  suggestion: {
    bar: [
      bar("hearBefore"),
      bar("hearAfter"),
      bar("keep"),
      bar("comment"),
      bar("more"),
      bar("inspect"),
    ],
    more: [row("adjustBounds"), row("seek")],
  },
  chapter: {
    bar: [bar("hear"), bar("fixText"), bar("remove"), bar("inspect")],
    more: [],
  },
  social: {
    bar: [
      bar("hear"),
      bar("comment"),
      bar("fixText"),
      bar("remove"),
      bar("inspect"),
    ],
    more: [],
  },
  comment: {
    bar: [bar("comment"), bar("remove"), bar("inspect")],
    more: [],
  },
  track: {
    bar: [bar("hear"), bar("remove"), bar("more"), bar("inspect")],
    more: [row("moveTrackUp"), row("moveTrackDown"), row("smoothJoins")],
  },
  envelope: {
    bar: [bar("inspect")],
    more: [],
  },
  envelopePoint: {
    bar: [bar("hear"), bar("remove"), bar("inspect")],
    more: [],
  },
  bleed: {
    bar: [bar("hearBefore"), bar("hearAfter"), bar("keep"), bar("inspect")],
    more: [],
  },
};

const GUARDS: Readonly<Record<Guard, (facts: EditFacts) => boolean>> = {
  holdsCut: (facts) => facts.holdsCut,
  hasGap: (facts) => facts.hasGap,
  host: (facts) => facts.role === "host",
  clipboardHasAudio: (facts) => facts.clipboardHasAudio,
};

/** The verb a pending edit's table default names. `leave` and an absent default offer no accept verb. */
const SUGGESTION_PRIMARY: Readonly<
  Record<NonNullable<PendingSuggestedAction>, VerbId | null>
> = {
  cut: "cut",
  shorten: "shorten",
  lower: "lower",
  leave: null,
};

export type ResolvedBar = {
  readonly leading: "scope" | "count" | null;
  /** In `EDIT_ORDER`, guards applied, primary excluded. */
  readonly bar: readonly BarId[];
  readonly more: readonly MoreRowId[];
  readonly primary: VerbId | null;
};

function primaryOf(facts: EditFacts): VerbId | null {
  if (facts.role === "readOnly") return null;
  switch (facts.kind) {
    case "words":
    case "range":
      return "cut";
    case "suggestion":
      return facts.suggestedAction
        ? SUGGESTION_PRIMARY[facts.suggestedAction]
        : null;
    case "social":
      return "approve";
    case "comment":
      return facts.commentResolved ? null : "resolve";
    default:
      return null;
  }
}

export function resolveBar(facts: EditFacts): ResolvedBar {
  if (facts.role === "readOnly")
    return facts.kind === "words"
      ? {
          leading: null,
          bar: READ_ONLY_WORD_BAR,
          more: READ_ONLY_WORD_MORE,
          primary: null,
        }
      : { leading: null, bar: READ_ONLY_BAR, more: [], primary: null };
  const set = ACTION_SETS[facts.kind];
  const allowed = <Id extends string>(rule: Rule<Id>) =>
    !rule.when || GUARDS[rule.when](facts);
  const more = set.more.filter(allowed).map((rule) => rule.id);
  const ids = set.bar
    .filter(allowed)
    .map((rule) => rule.id)
    .filter((id) => id !== "more" || more.length > 0)
    .sort((a, b) => EDIT_ORDER.indexOf(a) - EDIT_ORDER.indexOf(b));
  const leading =
    facts.kind === "words" || facts.kind === "range"
      ? "scope"
      : facts.count > 1
        ? "count"
        : null;
  return { leading, bar: ids, more, primary: primaryOf(facts) };
}

const MORE_COMMANDS: Readonly<
  Record<MoreCommandId, { label: string; icon: SystemIconName | null }>
> = {
  paste: { label: "Paste", icon: "clipboard-paste" },
  copy: { label: "Copy", icon: "copy" },
  moveTrackUp: { label: "Move track up", icon: null },
  moveTrackDown: { label: "Move track down", icon: null },
  smoothJoins: { label: "Smooth all joins", icon: null },
  moveToSpeaker: { label: "Move to speaker", icon: null },
  fillRoomTone: { label: "Fill room tone", icon: null },
  gain: { label: "Gain", icon: null },
  fade: { label: "Fade", icon: null },
  moveToTrack: { label: "Move to track", icon: null },
  adjustBounds: { label: "Adjust bounds", icon: null },
  seek: { label: "Seek to start", icon: null },
};

const SEGMENTED_DISPLAY: Readonly<
  Record<SegmentedBarId, { label: string; icon: SystemIconName | null }>
> = {
  joinType: { label: "Join type", icon: null },
};

const isVerbId = (id: BarId): id is VerbId =>
  VERBS.some((verb) => verb.id === id);

const isSegmentedId = (id: BarId): id is SegmentedBarId =>
  id in SEGMENTED_DISPLAY;

export type BarDisplay = {
  readonly label: string;
  readonly icon: SystemIconName | null;
  /** The first key as a tooltip suffix: ` (X)`, or empty. */
  readonly hint: string;
  readonly shortcut?: string;
};

export function barDisplay(id: BarId): BarDisplay {
  if (isSegmentedId(id)) return { ...SEGMENTED_DISPLAY[id], hint: "" };
  if (!isVerbId(id)) return { ...MORE_COMMANDS[id], hint: "" };
  const def = verbOf(id);
  const shortcut = ariaShortcutOf(def);
  return {
    label: def.label,
    icon: def.icon,
    hint: hintOf(def),
    ...(shortcut ? { shortcut } : {}),
  };
}
