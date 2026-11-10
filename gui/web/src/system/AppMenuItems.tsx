import { MenuItem } from "../ui";
import { SystemIcon } from "./SystemIcon";

/** The app menu button (the Project menu, or Home's wordmark), which Help opens under. */
export const APP_MENU_SELECTOR = "[data-app-menu]";

export type AppMenuRow = "settings" | "agent" | "help";

/** The rows every app menu ends with, in a project and on Home (design-system L29). */
export function AppMenuItems({
  onSelect,
}: {
  onSelect: (row: AppMenuRow) => void;
}) {
  return (
    <>
      <MenuItem onSelect={() => onSelect("settings")}>
        <SystemIcon name="settings" size={16} />
        Settings
      </MenuItem>
      <MenuItem onSelect={() => onSelect("agent")}>
        <SystemIcon name="plug" size={16} />
        Connect agent
      </MenuItem>
      <MenuItem onSelect={() => onSelect("help")}>
        <SystemIcon name="circle-help" size={16} />
        Help
      </MenuItem>
    </>
  );
}
