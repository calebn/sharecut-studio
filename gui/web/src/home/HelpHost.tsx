import { openGuides } from "../commands/host";
import { useViewportClass } from "../hooks/useViewportClass";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import { APP_MENU_SELECTOR } from "../system/AppMenuItems";
import { HelpDialog } from "./HelpDialog";

const appMenuButton = {
  get current() {
    return document.querySelector<HTMLElement>(APP_MENU_SELECTOR);
  },
};

/**
 * Help from the app menu opens on its three rows: on desktop as a popover
 * under the menu button, on phone and tablet as a sheet. "Report a problem"
 * from the palette opens straight on the report step as a sheet, since the
 * palette it came from was not beside that button.
 */
export function HelpHost() {
  const open = useDaw((s) => s.chrome.helpDialogOpen);
  const step = useDaw((s) => s.chrome.helpDialogStep);
  const fromMenu = useViewportClass() === "desktop" && step === "menu";
  const { setHelpDialogOpen, setCommandPaletteOpen } = useDawStore.getState();
  return (
    <HelpDialog
      open={open}
      anchorRef={fromMenu && appMenuButton.current ? appMenuButton : undefined}
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
