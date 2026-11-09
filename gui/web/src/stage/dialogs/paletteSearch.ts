/**
 * Store-free command palette model: one row per runnable catalog command, its
 * shortcut when it has one, and why it cannot run here. `commandPaletteRows.ts`
 * builds the rows from the live catalog and keymap; the view searches them.
 */
import { gestureLabel, MOBILE_GESTURES } from "../../commands/gestures";
import type { CommandCategory } from "../../commands/types";
import type { SystemIconName } from "../../system/icons";

/**
 * Commands the palette lists under their own group instead of their category:
 * the Go to <stage> commands under Stages, and `help.*` under Help.
 */
export type PaletteCommandGroup = "stages" | "help";

export const PALETTE_COMMAND_GROUP_LABELS: Readonly<
  Record<PaletteCommandGroup, string>
> = { stages: "Stages", help: "Help" };

export type PaletteCommand = {
  id: string;
  label: string;
  category: CommandCategory;
  /** Catalog `keywords`: synonyms search matches besides the label. */
  keywords?: readonly string[];
  /** Platform shortcut text, e.g. "⌘E" or "Ctrl+E"; null without keys. */
  shortcut: string | null;
  /** Registry key, the remap field's placeholder; only on keyed commands. */
  defaultKey?: string;
  /** Shared-key note (see `KeymapCommand.collision`), shown under the row. */
  note?: string;
  /** Why the command cannot run right now; null when it can. */
  disabledReason: string | null;
  /** Own group (Stages, Help) instead of the category section when browsing. */
  group?: PaletteCommandGroup;
  /** Verb icon (`system/verbs.ts`) drawn before the label; decorative. */
  icon?: SystemIconName;
};

export const PALETTE_CATEGORY_LABELS: Readonly<
  Record<CommandCategory, string>
> = {
  transport: "Transport",
  navigation: "Navigation",
  review: "Review",
  history: "History",
  edit: "Edit",
  view: "View",
  ui: "App",
  presence: "Following",
};

/** Consecutive rows of one category, in the order given. */
export function groupPaletteCommands(
  commands: readonly PaletteCommand[],
): { category: CommandCategory; rows: PaletteCommand[] }[] {
  const groups: { category: CommandCategory; rows: PaletteCommand[] }[] = [];
  for (const command of commands) {
    const last = groups.at(-1);
    if (last?.category === command.category) {
      last.rows.push(command);
    } else {
      groups.push({ category: command.category, rows: [command] });
    }
  }
  return groups;
}

/**
 * Every query word must appear in the label, a catalog keyword, the category
 * or the shortcut. Labels
 * that start with the query rank first, then labels with a word starting with
 * it, then the rest; commands that can run come before ones that cannot.
 */
export function searchPaletteCommands(
  commands: readonly PaletteCommand[],
  query: string,
): PaletteCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return [...commands];
  }
  const words = q.split(/\s+/);
  const ranked: { command: PaletteCommand; rank: number; index: number }[] = [];
  commands.forEach((command, index) => {
    const label = command.label.toLowerCase();
    const haystack = [
      label,
      ...(command.keywords ?? []),
      (command.group
        ? PALETTE_COMMAND_GROUP_LABELS[command.group]
        : PALETTE_CATEGORY_LABELS[command.category]
      ).toLowerCase(),
      command.shortcut?.toLowerCase() ?? "",
    ].join(" ");
    if (!words.every((word) => haystack.includes(word))) {
      return;
    }
    const match = label.startsWith(q)
      ? 0
      : label.split(/[^\p{L}\p{N}]+/u).some((w) => w.startsWith(words[0]))
        ? 1
        : 2;
    ranked.push({
      command,
      rank: match * 2 + (command.disabledReason ? 1 : 0),
      index,
    });
  });
  return ranked
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((r) => r.command);
}

export type PaletteEntryGroup = "projects" | "people" | "chapters";

export const PALETTE_ENTRY_GROUP_ORDER: readonly PaletteEntryGroup[] = [
  "projects",
  "people",
  "chapters",
];

export const PALETTE_ENTRY_GROUP_LABELS: Readonly<
  Record<PaletteEntryGroup, string>
> = {
  projects: "Projects",
  people: "People",
  chapters: "Chapters",
};

/**
 * A palette row that is data rather than a catalog command: a recent project,
 * a person in the session, a chapter. Running it runs `commandId` with `args`
 * through the command registry. Its row is built only when the command's gate
 * passes (`paletteEntries`), and the palette re-checks the gate when it runs.
 */
export type PaletteEntry = {
  /** Stable across opens (not a DOM id): recents are stored by it. */
  id: string;
  group: PaletteEntryGroup;
  label: string;
  /** Secondary text read with the label: a time, a role, a status. */
  context?: string;
  /** The action in words, for the status line: "Open", "Follow", "Go to". */
  verb: string;
  commandId: string;
  args: Record<string, unknown>;
};

/** Entries whose label, context or group name contains every query word, label matches first. */
export function searchPaletteEntries(
  entries: readonly PaletteEntry[],
  query: string,
): PaletteEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return [...entries];
  }
  const words = q.split(/\s+/);
  return entries
    .map((entry, index) => {
      const label = entry.label.toLowerCase();
      const haystack =
        `${label} ${entry.context ?? ""} ${PALETTE_ENTRY_GROUP_LABELS[entry.group]}`.toLowerCase();
      return { entry, index, hit: words.every((w) => haystack.includes(w)) };
    })
    .filter((r) => r.hit)
    .sort(
      (a, b) =>
        Number(!a.entry.label.toLowerCase().startsWith(q)) -
          Number(!b.entry.label.toLowerCase().startsWith(q)) ||
        a.index - b.index,
    )
    .map((r) => r.entry);
}

/** Non-empty entry groups in the fixed order Projects, People, Chapters. */
export function groupPaletteEntries(
  entries: readonly PaletteEntry[],
): { group: PaletteEntryGroup; rows: PaletteEntry[] }[] {
  return PALETTE_ENTRY_GROUP_ORDER.map((group) => ({
    group,
    rows: entries.filter((e) => e.group === group),
  })).filter((g) => g.rows.length > 0);
}

/** One touch gesture shown as a palette result row. */
export type PaletteGesture = {
  /** Stable row key, e.g. "gesture:Two-finger tap". */
  id: string;
  /** What the hand does, drawn where a command shows its keys. */
  gesture: string;
  /** What it does: the catalog label(s), or the gesture's own label. */
  action: string;
  description: string;
};

/** The touch-only Gestures result group's label. */
export const PALETTE_GESTURES_LABEL = "Gestures";

export const PALETTE_GESTURES: readonly PaletteGesture[] = MOBILE_GESTURES.map(
  (g) => ({
    id: `gesture:${g.gesture}`,
    gesture: g.gesture,
    action: gestureLabel(g),
    description: g.description,
  }),
);

/**
 * Gestures whose action, gesture name, "gestures" or "touch" contains every
 * query word, action matches first. The description stays out: its prose
 * would match nearly any query.
 */
export function searchPaletteGestures(
  gestures: readonly PaletteGesture[],
  query: string,
): PaletteGesture[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return [...gestures];
  }
  const words = q.split(/\s+/);
  return gestures
    .map((gesture, index) => {
      const action = gesture.action.toLowerCase();
      const haystack = `${action} ${gesture.gesture.toLowerCase()} ${PALETTE_GESTURES_LABEL.toLowerCase()} touch`;
      return {
        gesture,
        index,
        action,
        hit: words.every((w) => haystack.includes(w)),
      };
    })
    .filter((r) => r.hit)
    .sort(
      (a, b) =>
        Number(!a.action.startsWith(q)) - Number(!b.action.startsWith(q)) ||
        a.index - b.index,
    )
    .map((r) => r.gesture);
}

/** How many Recent rows an empty query shows. */
export const PALETTE_RECENT_LIMIT = 5;
