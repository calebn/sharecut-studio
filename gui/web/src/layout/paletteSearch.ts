/**
 * Store-free command palette model: one row per runnable catalog command, its
 * shortcut when it has one, and why it cannot run here. `commandPaletteRows.ts`
 * builds the rows from the live catalog and keymap; the view searches them.
 */
import type { CommandCategory } from "../commands/types";

export type PaletteCommand = {
  id: string;
  label: string;
  category: CommandCategory;
  /** Platform shortcut text, e.g. "⌘⇧E" or "Ctrl+Shift+E"; null without keys. */
  shortcut: string | null;
  /** Registry key, the remap field's placeholder; only on keyed commands. */
  defaultKey?: string;
  /** Shared-key note (see `KeymapCommand.collision`), shown under the row. */
  note?: string;
  /** Why the command cannot run right now; null when it can. */
  disabledReason: string | null;
};

export const PALETTE_CATEGORY_LABELS: Readonly<
  Record<CommandCategory, string>
> = {
  transport: "Transport",
  tools: "Tools",
  layout: "Layout",
  navigation: "Navigation",
  review: "Review",
  history: "History",
  edit: "Edit",
  view: "View",
  ui: "App",
  presence: "People",
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
 * Every query word must appear in the label, category or shortcut. Labels
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
      PALETTE_CATEGORY_LABELS[command.category].toLowerCase(),
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
