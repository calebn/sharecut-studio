import { runPointerCommand } from "../commands/pointer";
import { clearKeymapOverride, setKeymapOverride } from "../keymap/remaps";
import { useDaw } from "../state/useDaw";
import { CommandPaletteView } from "./CommandPaletteView";
import {
  commandPaletteCategories,
  commandPaletteUnbound,
} from "./commandPaletteRows";

/**
 * Keyboard shortcuts cheatsheet modal (Figma/Docs/? + Help menu prior art).
 * Open via ? or Transport Menu → Keyboard shortcuts.
 */
export function CommandPalette() {
  const { commandPaletteOpen, setCommandPaletteOpen, setGesturesSheetOpen } =
    useDaw((s) => ({
      commandPaletteOpen: s.commandPaletteOpen,
      setCommandPaletteOpen: s.setCommandPaletteOpen,
      setGesturesSheetOpen: s.setGesturesSheetOpen,
    }));

  return (
    <CommandPaletteView
      open={commandPaletteOpen}
      categories={commandPaletteCategories()}
      unbound={commandPaletteUnbound()}
      onClose={() => setCommandPaletteOpen(false)}
      onOpenGestures={() => {
        setCommandPaletteOpen(false);
        setGesturesSheetOpen(true);
      }}
      onRun={(id) => runPointerCommand(id)}
      onRemap={(id, trimmedKey) => {
        if (!trimmedKey) {
          clearKeymapOverride(id);
          return;
        }
        setKeymapOverride(id, [trimmedKey]);
      }}
    />
  );
}
