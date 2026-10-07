import { buildCommandContext } from "../commands/context";
import { executePointerCommand } from "../commands/pointer";
import { clearKeymapOverride, setKeymapOverride } from "../keymap/remaps";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import { CommandPaletteView } from "./CommandPaletteView";
import { paletteCommands } from "./commandPaletteRows";

/**
 * Command palette (Commands and shortcuts): every runnable catalog command,
 * searchable, with its keys. Open via ?, Transport Menu → Help, or the phone
 * More hub. Rows are rebuilt each time it opens so their reasons match now.
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
      commands={
        commandPaletteOpen ? paletteCommands(buildCommandContext()) : []
      }
      onClose={() => setCommandPaletteOpen(false)}
      onOpenGestures={() => {
        setCommandPaletteOpen(false);
        setGesturesSheetOpen(true);
      }}
      onRun={(id) => {
        // Close first: a command may open its own dialog, and dialogs never stack.
        setCommandPaletteOpen(false);
        void executePointerCommand(id).then((result) => {
          if (result.status === "disabled") {
            useDawStore.getState().announceStatus(result.reason);
          }
        });
      }}
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
