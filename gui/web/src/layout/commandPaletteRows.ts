/**
 * Builds CommandPaletteView's rows from the live keymap registry, including
 * remap overrides. It imports the store-bound registry at runtime, so
 * CommandPaletteView.tsx and its stories only `import type` from this module.
 */
import { COMMANDS, listCatalogIds } from "../commands/catalog";
import {
  formatShortcutKeys,
  KEYMAP_CATEGORY_ORDER,
  KEYMAP_COMMANDS,
  type KeymapCategory,
  keymapByCategory,
} from "../keymap/registry";

export interface CommandPaletteShortcutRow {
  id: string;
  label: string;
  shortcut: string;
  defaultKey?: string;
  /** A shared-key collision note (see `KeymapCommand.collision`), shown under the row. */
  note?: string;
}

export interface CommandPaletteCategory {
  category: KeymapCategory;
  rows: CommandPaletteShortcutRow[];
}

export interface CommandPaletteAction {
  id: string;
  label: string;
}

/** Keymapped commands grouped by category, in cheatsheet display order, empty ones dropped. */
export function commandPaletteCategories(): CommandPaletteCategory[] {
  const byCat = keymapByCategory();
  return KEYMAP_CATEGORY_ORDER.filter(
    (category) => (byCat[category] ?? []).length,
  ).map((category) => ({
    category,
    rows: (byCat[category] ?? []).map((cmd) => ({
      id: cmd.id,
      label: cmd.label,
      shortcut: formatShortcutKeys(cmd),
      defaultKey: cmd.keys[0],
      note: cmd.collision,
    })),
  }));
}

/** Catalog commands runnable from the palette that have no keyboard binding. */
export function commandPaletteUnbound(): CommandPaletteAction[] {
  return listCatalogIds()
    .filter(
      (id) =>
        COMMANDS[id]?.paletteRunnable !== false &&
        !KEYMAP_COMMANDS.some((k) => k.id === id),
    )
    .map((id) => ({ id, label: COMMANDS[id]?.label ?? id }));
}
