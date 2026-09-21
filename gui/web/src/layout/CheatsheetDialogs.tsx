import { useDaw } from "../state/useDaw";
import { GesturesSheet } from "../ui";
import { CommandPalette } from "./CommandPalette";

/** App-level cheatsheets stay beside app chrome so modal inertness is valid. */
export function CheatsheetDialogs() {
  const { gesturesSheetOpen, setCommandPaletteOpen, setGesturesSheetOpen } =
    useDaw();

  return (
    <>
      <CommandPalette />
      <GesturesSheet
        open={gesturesSheetOpen}
        onClose={() => setGesturesSheetOpen(false)}
        onShowKeyboardShortcuts={() => {
          setGesturesSheetOpen(false);
          setCommandPaletteOpen(true);
        }}
      />
    </>
  );
}
