import { openGuides } from "../commands/host";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import { HelpDialog } from "./HelpDialog";

export function HelpHost() {
  const open = useDaw((s) => s.chrome.helpDialogOpen);
  const step = useDaw((s) => s.chrome.helpDialogStep);
  const { setHelpDialogOpen, setCommandPaletteOpen } = useDawStore.getState();
  return (
    <HelpDialog
      open={open}
      initialStep={step}
      onClose={() => setHelpDialogOpen(false)}
      onOpenShortcuts={() => {
        setHelpDialogOpen(false);
        setCommandPaletteOpen(true);
      }}
      onOpenGuides={openGuides}
    />
  );
}
