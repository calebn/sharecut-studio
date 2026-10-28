import type { StageId } from "../types/stage";
import type { SystemIconName } from "./icons";

/**
 * Verb, icon, key and gesture table from section 3 of the stage design system
 * (docs/design/stages/design-system.md). Pure data: nothing here is wired to the
 * command bus or keymap yet.
 *
 * Statuses are checked against the live keymap (`src/keymap/registry.ts`) by
 * `verbs.test.ts`, so they cannot drift.
 * `bound`: the verb's first key already drives `commandId` (extra keys of the
 * same verb may still be new, as `/` is for Palette).
 * `conflict`: a key of the verb is live for a different command; `replaces` names
 * those ids, which the adoption slice must retire or move.
 * `new`: no key of the verb is live for `commandId`; it is the command the key
 * will drive.
 */
export type VerbStatus = "bound" | "conflict" | "new";

export type TouchGesture =
  | "tap"
  | "double-tap"
  | "long-press"
  | "press-and-hold"
  | "swipe-right"
  | "swipe-left"
  | "swipe-up"
  | "swipe-down"
  | "swipe-timeline"
  | "swipe-dock-up"
  | "pinch"
  | "two-finger-tap"
  | "three-finger-swipe";

export type KeySpec = {
  /** `event.key` style name; letters are upper case, as in the keymap. */
  readonly key: string;
  readonly mod?: true;
  readonly shift?: true;
  readonly alt?: true;
  /** Milliseconds the key is held. */
  readonly hold?: number;
};

export type VerbDef = {
  readonly id: string;
  readonly label: string;
  readonly icon: SystemIconName | null;
  /** The icon while the verb is on or toggled (Pause, Hide, mic). */
  readonly iconAlt?: SystemIconName;
  readonly keys: readonly KeySpec[];
  readonly touch: TouchGesture | null;
  readonly surfaces: readonly string[];
  readonly status: VerbStatus;
  /** Command catalog id, as a string so this module imports nothing. */
  readonly commandId?: string;
  /** Command ids whose live key this verb takes over. */
  readonly replaces?: readonly string[];
  /** Other live commands the same keys already drive (Zoom: in, out and fit). */
  readonly alsoBound?: readonly string[];
  readonly note?: string;
};

const k = (key: string, mods: Omit<KeySpec, "key"> = {}): KeySpec => ({
  key,
  ...mods,
});
const mod = (key: string, more: Omit<KeySpec, "key" | "mod"> = {}): KeySpec =>
  k(key, { mod: true, ...more });

export const VERBS = [
  {
    id: "play",
    label: "Play / Pause",
    icon: "play",
    iconAlt: "pause",
    keys: [k("Space")],
    touch: "tap",
    surfaces: ["player", "expanded-player"],
    status: "bound",
    commandId: "transport.togglePlay",
  },
  {
    id: "shuttle",
    label: "Shuttle",
    icon: null,
    keys: [k("J"), k("K"), k("L")],
    touch: "swipe-timeline",
    surfaces: ["player"],
    status: "conflict",
    replaces: ["transport.stop"],
    note: "K stops playback today; J and L are new. Repeats go 1x, 2x, 4x.",
  },
  {
    id: "hear",
    label: "Hear",
    icon: "ear",
    keys: [k("Space", { shift: true })],
    touch: "tap",
    surfaces: [
      "action-bar",
      "decision-card",
      "take-row",
      "source-card",
      "status-row",
    ],
    status: "bound",
    commandId: "edit.hear",
    note: "Plain Space still toggles play; the Play row now ignores Shift. Shift+Space works on a focused word, clip or bar button.",
  },
  {
    id: "hearBefore",
    label: "Hear before",
    icon: null,
    keys: [k("A")],
    touch: "press-and-hold",
    surfaces: ["decision-card", "seam", "suggestion", "player"],
    status: "bound",
    commandId: "edit.hearBefore",
    note: "Hold A with nothing selected to hear the original (the hold is not built yet; A on a suggestion plays it as it is).",
  },
  {
    id: "hearAfter",
    label: "Hear after",
    icon: null,
    keys: [k("B")],
    touch: "tap",
    surfaces: ["decision-card", "seam", "suggestion", "player"],
    status: "bound",
    commandId: "edit.hearAfter",
  },
  {
    id: "cut",
    label: "Cut",
    icon: "scissors",
    keys: [k("Backspace"), k("Delete")],
    touch: "swipe-right",
    surfaces: [
      "action-bar",
      "decision-card",
      "queue-group",
      "find-bar",
      "toast",
    ],
    status: "bound",
    commandId: "edit.delete",
    note: "Mod+X stays Cut-to-clipboard (edit.cut), not this verb.",
  },
  {
    id: "keep",
    label: "Keep",
    icon: "shield-check",
    keys: [k("X")],
    touch: "swipe-left",
    surfaces: ["action-bar", "decision-card", "queue-row", "auto-reduction"],
    status: "bound",
    commandId: "edit.keep",
  },
  {
    id: "shorten",
    label: "Shorten",
    icon: "fold-horizontal",
    keys: [k("Enter")],
    touch: "swipe-right",
    surfaces: ["pause-suggestion"],
    status: "conflict",
    replaces: ["tighten.applyHit"],
  },
  {
    id: "lower",
    label: "Lower",
    icon: "volume-1",
    keys: [k("Enter")],
    touch: "swipe-right",
    surfaces: ["sound-suggestion"],
    status: "conflict",
    replaces: ["tighten.applyHit"],
  },
  {
    id: "replace",
    label: "Replace",
    icon: "replace",
    keys: [k("Enter")],
    touch: "swipe-right",
    surfaces: ["pickup-suggestion", "session-suggestion"],
    status: "conflict",
    replaces: ["tighten.applyHit"],
  },
  {
    id: "insert",
    label: "Insert",
    icon: "between-horizontal-start",
    keys: [k("Enter")],
    touch: "swipe-right",
    surfaces: ["pickup-suggestion", "session-suggestion"],
    status: "conflict",
    replaces: ["tighten.applyHit"],
  },
  {
    id: "approve",
    label: "Approve",
    icon: "check",
    keys: [k("Enter")],
    touch: "swipe-right",
    surfaces: ["check-row", "clip-idea"],
    status: "conflict",
    replaces: ["tighten.applyHit"],
  },
  {
    id: "resolve",
    label: "Resolve",
    icon: "message-square-check",
    keys: [k("Enter")],
    touch: "swipe-right",
    surfaces: ["decision-card", "queue-row"],
    status: "conflict",
    commandId: "comment.resolve",
    replaces: ["tighten.applyHit"],
  },
  {
    id: "later",
    label: "Later",
    icon: "chevron-down",
    keys: [k("Tab"), k("ArrowDown")],
    touch: "swipe-up",
    surfaces: ["decision-card", "review-dock"],
    status: "conflict",
    replaces: ["track.moveDown"],
    note: "ArrowDown moves the selected track down today.",
  },
  {
    id: "next",
    label: "Next / Previous",
    icon: null,
    keys: [k("Tab"), k("Tab", { shift: true }), k("ArrowDown"), k("ArrowUp")],
    touch: "swipe-up",
    surfaces: ["review-queue", "edit-after-cut", "fix-text"],
    status: "conflict",
    replaces: ["track.moveDown", "track.moveUp"],
    note: "Swipe up goes to the next and swipe down to the previous, on the card. The arrows move the selected track today.",
  },
  {
    id: "applyAll",
    label: "Apply to all like this",
    icon: null,
    keys: [k("Enter", { shift: true })],
    touch: "tap",
    surfaces: ["queue-group", "find-bar", "toast"],
    status: "conflict",
    replaces: ["tighten.applyHit"],
    note: "Shows the verb's own icon with a count. The Tighten row ignores Shift, so Shift+Enter applies a hit today.",
  },
  {
    id: "split",
    label: "Split",
    icon: "square-split-horizontal",
    keys: [k("S"), mod("K")],
    touch: "tap",
    surfaces: ["action-bar", "playhead-menu", "dock"],
    status: "bound",
    commandId: "edit.split",
    alsoBound: ["edit.bladeCut"],
    note: "S splits at the playhead, or at both edges of the selected words or range. Mod+K splits at the playhead. Alt-click at the pointer is the pointer form; the table has no field for it. Solo moved to Shift+S.",
  },
  {
    id: "comment",
    label: "Comment",
    icon: "message-square",
    keys: [k("C")],
    touch: "tap",
    surfaces: [
      "player",
      "action-bar",
      "record-dock",
      "decision-card",
      "marker",
      "review-queue",
    ],
    status: "bound",
    commandId: "comment.draftAt",
    note: "Long-press composes with the time pinned. C was the Blade tool until it was removed; the action bar binds it.",
  },
  {
    id: "fixText",
    label: "Fix text",
    icon: "text-cursor-input",
    keys: [k("F2")],
    touch: "double-tap",
    surfaces: [
      "script",
      "decision-card",
      "marker-title",
      "speaker",
      "project-title",
      "session-name",
    ],
    status: "bound",
    commandId: "transcript.editWordInline",
  },
  {
    id: "remove",
    label: "Remove",
    icon: "trash-2",
    keys: [k("Backspace"), k("Delete")],
    touch: "swipe-left",
    surfaces: [
      "marker",
      "comment",
      "track",
      "envelope-point",
      "chapter-row",
      "clip-idea",
      "home-recent",
      "person",
    ],
    status: "bound",
    commandId: "track.remove",
  },
  {
    id: "mute",
    label: "Mute",
    icon: "volume-x",
    iconAlt: "mic-off",
    keys: [k("M")],
    touch: "tap",
    surfaces: [
      "track-header",
      "mix-sheet",
      "action-bar",
      "record-dock",
      "person-tile",
    ],
    status: "conflict",
    commandId: "edit.mute",
    replaces: ["record.marker"],
    note: "Mute everywhere, on what is selected (words, a range, a clip) or else the targeted track; the live marker on the Record stage moves to Comment.",
  },
  {
    id: "solo",
    label: "Solo",
    icon: "headphones",
    keys: [k("S", { shift: true })],
    touch: "tap",
    surfaces: ["track-header", "mix-sheet", "solo-pill"],
    status: "bound",
    commandId: "track.soloToggle",
    note: "Shift+S: bare S is Split (Caleb, 2026-10-28).",
  },
  {
    id: "inspect",
    label: "Inspect",
    icon: "sliders-horizontal",
    keys: [k("I")],
    touch: "swipe-dock-up",
    surfaces: ["action-bar", "prepare-advanced"],
    status: "bound",
    commandId: "edit.inspect",
    note: "The Inspector opens only on Inspect (I, this verb, or a double-click on a selection); selecting never opens it.",
  },
  {
    id: "more",
    label: "More",
    icon: "ellipsis",
    keys: [k(".")],
    touch: "long-press",
    surfaces: ["action-bar", "row", "card"],
    status: "bound",
    commandId: "edit.more",
  },
  {
    id: "record",
    label: "Record",
    icon: "record",
    keys: [k("R"), k("R", { hold: 600 })],
    touch: "tap",
    surfaces: [
      "stage-bar",
      "start-tile",
      "record-button",
      "action-bar",
      "plus-menu",
    ],
    status: "new",
    commandId: "record.start",
    note: "Hold R or the button 600 ms to stop. In Edit it opens Record with a Replace or Insert target.",
  },
  {
    id: "pauseTake",
    label: "Pause take",
    icon: "pause",
    keys: [k("P")],
    touch: "tap",
    surfaces: ["record-dock"],
    status: "conflict",
    commandId: "record.pause",
    replaces: ["tighten.previewHit"],
  },
  {
    id: "invite",
    label: "Invite",
    icon: "user-plus",
    keys: [],
    touch: "tap",
    surfaces: ["app-header", "person-tile", "deliver"],
    status: "new",
    commandId: "share.manage",
  },
  {
    id: "copyLink",
    label: "Copy link",
    icon: "copy",
    keys: [],
    touch: "tap",
    surfaces: ["link-row"],
    status: "new",
    commandId: "record.copyGuestLink",
  },
  {
    id: "export",
    label: "Export",
    icon: "download",
    keys: [mod("E")],
    touch: "tap",
    surfaces: ["deliver", "action-bar"],
    status: "new",
    commandId: "export.deliverables",
    note: "Mod+Shift+E drives this command today; Mod+E is free. With a range selected it exports the range.",
  },
  {
    id: "import",
    label: "Import",
    icon: "file-plus",
    keys: [mod("I")],
    touch: "tap",
    surfaces: ["start-tile", "prepare", "edit-plus-menu"],
    status: "bound",
    commandId: "media.import",
  },
  {
    id: "undo",
    label: "Undo",
    icon: "undo-2",
    keys: [mod("Z")],
    touch: "two-finger-tap",
    surfaces: ["app-header", "toast"],
    status: "bound",
    commandId: "history.undo",
    note: "Long-press Undo opens History.",
  },
  {
    id: "redo",
    label: "Redo",
    icon: "redo-2",
    keys: [mod("Z", { shift: true })],
    touch: "three-finger-swipe",
    surfaces: ["app-header", "toast"],
    status: "bound",
    commandId: "history.redo",
  },
  {
    id: "addChapter",
    label: "Add chapter",
    icon: "flag",
    keys: [k("C", { shift: true })],
    touch: "double-tap",
    surfaces: ["playhead-menu", "dock", "deliver-chapters"],
    status: "bound",
    commandId: "edit.addChapter",
    note: "The Blade row that ignored Shift is gone; the action bar binds Shift+C.",
  },
  {
    id: "find",
    label: "Find in transcript",
    icon: "text-search",
    keys: [mod("F")],
    touch: "tap",
    surfaces: ["script-header"],
    status: "new",
    commandId: "transcript.findReplace",
  },
  {
    id: "palette",
    label: "Palette",
    icon: "search",
    keys: [k("/"), k("?")],
    touch: "tap",
    surfaces: ["app-header"],
    status: "bound",
    commandId: "ui.toggleCommandPalette",
    note: "? is live; / is new.",
  },
  {
    id: "propose",
    label: "Propose",
    icon: "wand-sparkles",
    keys: [],
    touch: "tap",
    surfaces: ["review-queue-header", "deliver-clips", "prepare"],
    status: "new",
  },
  {
    id: "goToStage",
    label: "Go to stage",
    icon: "arrow-right",
    keys: [
      mod("1"),
      mod("2"),
      mod("3"),
      mod("4"),
      mod("5"),
      mod("Enter"),
      k("E"),
    ],
    touch: "tap",
    surfaces: ["stage-bar", "hand-off", "readiness-fix", "decision-card"],
    status: "bound",
    commandId: "stage.edit",
    alsoBound: [
      "stage.record",
      "stage.prepare",
      "stage.review",
      "stage.deliver",
    ],
    note: "Mod+1 to Mod+5 are stages, Mod+Enter hands off, E opens the object in Edit.",
  },
  {
    id: "follow",
    label: "Follow",
    icon: "locate-fixed",
    keys: [k("Escape")],
    touch: "tap",
    surfaces: ["person-sheet", "player-ring"],
    status: "bound",
    commandId: "presence.unfollow",
    note: "Escape stops following.",
  },
  {
    id: "leaveRoom",
    label: "Leave room",
    icon: "door-open",
    keys: [],
    touch: "tap",
    surfaces: ["record-guest-dock", "record-producer-dock"],
    status: "new",
  },
  {
    id: "getModel",
    label: "Get model",
    icon: "cloud-download",
    keys: [],
    touch: "tap",
    surfaces: ["status-row", "settings"],
    status: "new",
    commandId: "models.open",
  },
  {
    id: "splitSpeakers",
    label: "Split speakers",
    icon: "split",
    keys: [],
    touch: "tap",
    surfaces: ["source-card"],
    status: "new",
    commandId: "track.splitSpeakers",
  },
  {
    id: "showHide",
    label: "Show / hide",
    icon: "eye",
    iconAlt: "eye-off",
    keys: [],
    touch: "tap",
    surfaces: ["view-sheet", "script-cut-text"],
    status: "new",
  },
  {
    id: "zoom",
    label: "Zoom",
    icon: null,
    keys: [k("="), k("-"), k("\\"), k("Z")],
    touch: "pinch",
    surfaces: ["timeline"],
    status: "bound",
    commandId: "view.zoomIn",
    alsoBound: ["view.zoomOut", "view.fit"],
    note: "= in, - out, \\ fit are live; Z to selection is new.",
  },
] as const satisfies readonly VerbDef[];

export type VerbId = (typeof VERBS)[number]["id"];

/** One shared chord set: the design system reuses these keys by object kind. */
type ChordGroup = {
  readonly chords: readonly string[];
  readonly verbs: readonly VerbId[];
  readonly reason: string;
};

export const CHORD_ALLOW_GROUPS = [
  {
    chords: ["Enter"],
    verbs: ["shorten", "lower", "replace", "insert", "approve", "resolve"],
    reason: "Enter does the selected object's primary action.",
  },
  {
    chords: ["Backspace", "Delete"],
    verbs: ["cut", "remove"],
    reason: "Cut on audio, Remove on a non-audio object.",
  },
  {
    chords: ["Tab", "ArrowDown"],
    verbs: ["later", "next"],
    reason: "Moving on and stepping to the next of a kind are the same move.",
  },
] as const satisfies readonly ChordGroup[];

/**
 * Glyphs the design system deliberately reuses. Owners are verb ids, `stage:`
 * ids or `role:` names (a meaning outside the verb table). Any other icon with
 * two owners is a collision.
 */
export const ICON_TIES = [
  {
    icon: "ear",
    owners: ["hear", "role:can-listen"],
    reason: "Both mean listening.",
  },
  {
    icon: "headphones",
    owners: ["solo", "role:join-headphones-toggle"],
    reason: "Both are about what reaches your ears.",
  },
  {
    icon: "pause",
    owners: ["play", "pauseTake"],
    reason:
      "Play toggles to Pause; Pause take is the same glyph in the Record dock.",
  },
  {
    icon: "record",
    owners: ["record", "stage:record", "status:live"],
    reason:
      "The Record verb, the Record stage and the Live status are one glyph. The clock in section 4.6 is the pill's time text, not part of the glyph.",
  },
  {
    icon: "wand-sparkles",
    owners: ["propose", "stage:prepare"],
    reason: "Prepare proposes what to do with the audio.",
  },
] as const satisfies readonly {
  icon: SystemIconName;
  owners: readonly string[];
  reason: string;
}[];

/** Letters browsers reserve behind Mod (Mod+N and so on): never used with Mod. */
export const BROWSER_RESERVED_KEYS = ["N", "T", "W", "R", "D"] as const;

export const GESTURE_GRAMMAR = [
  { gesture: "tap", meaning: "selects" },
  {
    gesture: "long-press",
    meaning: "opens a menu, or selects a range if you drag",
  },
  { gesture: "swipe-right", meaning: "does the primary" },
  { gesture: "swipe-left", meaning: "does the no (Keep or Remove)" },
  { gesture: "swipe-up", meaning: "moves on" },
  { gesture: "pinch", meaning: "zooms" },
  { gesture: "two-finger-tap", meaning: "undoes" },
] as const satisfies readonly { gesture: TouchGesture; meaning: string }[];

/** Stage order is Q1 default (a) in docs/design/stages/open-questions.md. */
export const STAGES = [
  { id: "record", label: "Record", icon: "record", key: mod("1") },
  { id: "prepare", label: "Prepare", icon: "wand-sparkles", key: mod("2") },
  { id: "edit", label: "Edit", icon: "stage-edit", key: mod("3") },
  { id: "review", label: "Review", icon: "inbox", key: mod("4") },
  { id: "deliver", label: "Deliver", icon: "send", key: mod("5") },
] as const satisfies readonly {
  id: StageId;
  label: string;
  icon: SystemIconName;
  key: KeySpec;
}[];

export function stageLabel(id: StageId): string {
  return (STAGES.find((s) => s.id === id) as { label: string }).label;
}

/** The one status glyph set (section 4.6). */
export const STATUS_GLYPHS = [
  { state: "done", glyph: "circle-check", tone: "success" },
  { state: "running", glyph: "progress-ring", tone: "neutral" },
  { state: "not-yet", glyph: "circle", tone: "neutral" },
  { state: "needs-you", glyph: "triangle-alert", tone: "warning" },
  { state: "failed", glyph: "octagon-alert", tone: "danger" },
  { state: "offline", glyph: "cloud-off", tone: "warning" },
  { state: "live", glyph: "record", tone: "record" },
] as const satisfies readonly {
  state: string;
  glyph: SystemIconName;
  tone: "success" | "neutral" | "warning" | "danger" | "record";
}[];

/** `Mod+Shift+Z` style label for a key, used for uniqueness and display. */
export function chordOf(spec: KeySpec): string {
  return [
    spec.mod ? "Mod" : "",
    spec.alt ? "Alt" : "",
    spec.shift ? "Shift" : "",
    spec.key + (spec.hold ? `@${spec.hold}` : ""),
  ]
    .filter(Boolean)
    .join("+");
}
