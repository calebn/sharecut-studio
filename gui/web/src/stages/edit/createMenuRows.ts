import type { SystemIconName } from "../../system/icons";
import { capsOf, verbOf } from "../../system/verbDisplay";
import type { KeySpec, VerbDef } from "../../system/verbs";
import { isApplePlatform } from "../../utils/platform";

/**
 * The Create here menu's rows (spec-edit MENU-CREATE) as plain data. A row
 * the held point cannot take is absent, never disabled, so there is no reason
 * text. Split, Comment and Add chapter take their icon and keys from the verb
 * table; Add volume point and Paste are not verbs, so they are local entries
 * (Paste borrows the clipboard-paste icon of the Action bar's More menu).
 * Rows carry no command id: the host maps `onPick(id)` to commands, with the
 * held time. `recordHere` is the host's own row: `createMenuRows` never emits
 * it, and the host splices it in and takes the picked id back.
 */
export type CreateRowId =
  | "split"
  | "comment"
  | "addChapter"
  | "addVolumePoint"
  | "paste"
  | "recordHere";

export type CreateRow = {
  id: CreateRowId;
  label: string;
  icon: SystemIconName;
  keys: readonly KeySpec[];
  /**
   * What the row will act on, said once as plain text. Shown as the row's
   * description and tooltip; never part of its name and never a key cap.
   */
  note?: string;
  /** The row opens its own group: a separator is drawn above it. */
  startsGroup?: true;
};

/** What the held point offers. */
export type CreateFacts = {
  /** The point is on a lane, so a lane row can apply. */
  lane: boolean;
  /** The lane's volume envelope is showing. */
  envelopeShown: boolean;
  clipboardHasAudio: boolean;
};

// The labels are data: a derived "here" would only read right by accident.
const SPLIT = verbOf("split");
const COMMENT = verbOf("comment");
const CHAPTER = verbOf("addChapter");

function verbRow(
  id: "split" | "comment" | "addChapter",
  label: string,
  verb: VerbDef,
): CreateRow {
  if (!verb.icon) throw new Error(`Verb ${verb.id} has no icon`);
  return { id, label, icon: verb.icon, keys: verb.keys };
}

const SPLIT_ROW = verbRow("split", "Split here", SPLIT);
const COMMENT_ROW = verbRow("comment", "Comment here", COMMENT);
const CHAPTER_ROW = verbRow("addChapter", "Add chapter here", CHAPTER);
const VOLUME_ROW: CreateRow = {
  id: "addVolumePoint",
  label: "Add volume point",
  icon: "spline",
  keys: [],
  startsGroup: true,
};
const PASTE_ROW: CreateRow = {
  id: "paste",
  label: "Paste",
  icon: "clipboard-paste",
  keys: [],
};

/** Split, Comment, Add chapter, then the lane's Add volume point, then Paste. */
export function createMenuRows(facts: CreateFacts): CreateRow[] {
  return [
    SPLIT_ROW,
    COMMENT_ROW,
    CHAPTER_ROW,
    ...(facts.lane && facts.envelopeShown ? [VOLUME_ROW] : []),
    ...(facts.clipboardHasAudio ? [PASTE_ROW] : []),
  ];
}

/** The key caps shown on a row: its first chord only (`S`, `C`, `⇧ C`). */
export function rowShortcut(row: CreateRow): string | undefined {
  const first = row.keys[0];
  return first ? capsOf(first).join(" ") : undefined;
}

/** `aria-keyshortcuts` for every chord of a row (`S Control+K`). */
export function rowKeyShortcuts(
  row: CreateRow,
  apple: boolean = isApplePlatform(),
): string | undefined {
  const chords = row.keys.map((spec) =>
    [
      spec.mod ? (apple ? "Meta" : "Control") : "",
      spec.alt ? "Alt" : "",
      spec.shift ? "Shift" : "",
      spec.key.length === 1 ? spec.key.toUpperCase() : spec.key,
    ]
      .filter(Boolean)
      .join("+"),
  );
  return chords.length ? chords.join(" ") : undefined;
}
