/**
 * Builds the command palette's rows from the command catalog (the single
 * source), with each command's shortcut (in the Menu's platform form, ⌘⇧E
 * or Ctrl+Shift+E) and remap from the live keymap registry. It imports the store-bound registry at runtime, so
 * CommandPaletteView.tsx and its stories import the store-free model from
 * `paletteSearch.ts` instead.
 */
import { COMMANDS, listCatalogIds } from "../commands/catalog";
import { type CommandContext, evaluateWhen } from "../commands/context";
import {
  displayShortcutFor,
  KEYMAP_CATEGORY_ORDER,
  keymapCommandById,
} from "../keymap/registry";
import type { PaletteCommand } from "./paletteSearch";

/**
 * Runnable catalog commands in category order. A palette click runs a command
 * the way a pointer does, so focus-only keyboard gates (timeline or transcript
 * focus) count as met; every other `when` gate gives the row its reason.
 */
export function paletteCommands(ctx: CommandContext): PaletteCommand[] {
  const pointerCtx: CommandContext = {
    ...ctx,
    timelineFocused: true,
    editorFocused: true,
  };
  const rows = listCatalogIds()
    .map((id) => COMMANDS[id])
    // The palette does not list itself.
    .filter(
      (def) =>
        def != null &&
        def.paletteRunnable !== false &&
        def.id !== "ui.toggleCommandPalette",
    )
    .map((def): PaletteCommand => {
      const keyed = keymapCommandById(def.id);
      const gate = evaluateWhen(def.when, pointerCtx);
      return {
        id: def.id,
        label: def.label,
        category: def.category,
        shortcut: displayShortcutFor(def.id) ?? null,
        ...(keyed ? { defaultKey: keyed.keys[0] } : {}),
        ...(keyed?.collision ? { note: keyed.collision } : {}),
        disabledReason: gate.ok ? null : gate.reason,
      };
    });
  return KEYMAP_CATEGORY_ORDER.flatMap((category) =>
    rows.filter((row) => row.category === category),
  );
}
