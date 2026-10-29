import { useCallback } from "react";
import { runPointerCommand } from "../../commands/pointer";
import { useRenameProject } from "../../hooks/useRenameProject";
import { type ThemePreference, useTheme } from "../../hooks/useTheme";
import { useDawStore } from "../../state/dawStore";
import { stageRoleOf } from "../../state/stageRoutes";
import { useDaw } from "../../state/useDaw";
import type { AppHeaderProps } from "../../system/AppHeader";
import { useHistoryControls } from "./useHistoryControls";
import { useSaveIndicator } from "./useSaveIndicator";
import { useStageBarProps } from "./useStageBarProps";

/** The Project menu rows the header reports, and the command each one runs. */
const MENU_COMMANDS: Record<string, string> = {
  projects: "project.home",
  settings: "models.open",
  agent: "mcp.connect",
  help: "help.diagnosticsBundle",
};

/**
 * Everything `AppHeader` needs from the app, except the people slot: title,
 * Save indicator, Undo and Redo, the Stage bar with its badges, Invite, search
 * and the Project menu. The Stage bar is left out for a link that has one stage.
 */
export function useHeaderProps(): Omit<
  AppHeaderProps,
  "peopleSlot" | "menuPeople"
> {
  const { title, guestMode } = useDaw((s) => ({
    title: s.project?.meta.name ?? null,
    guestMode: s.guestMode,
  }));
  const onRename = useRenameProject();
  const save = useSaveIndicator();
  const history = useHistoryControls();
  const stages = useStageBarProps();
  const { preference, setPreference } = useTheme();
  const role = stageRoleOf(guestMode);
  const onMenuCommand = useCallback((command: string) => {
    const id = MENU_COMMANDS[command];
    if (id) runPointerCommand(id);
  }, []);
  const onHistory = useCallback(
    () => useDawStore.getState().setOpenSheet("history"),
    [],
  );
  return {
    title: title ?? "Project",
    loading: title === null,
    save: save ?? undefined,
    stages,
    guest: role === "host" ? undefined : { version: "Shared link", role },
    canUndo: history.history?.canUndo ?? false,
    canRedo: history.history?.canRedo ?? false,
    onUndo: history.onUndo,
    onRedo: history.onRedo,
    onInvite: () => runPointerCommand("share.manage"),
    onPalette: () => runPointerCommand("ui.toggleCommandPalette"),
    onRename: role === "host" ? onRename : undefined,
    onHistory: history.history ? onHistory : undefined,
    appearance: {
      value: preference,
      onChange: (value: ThemePreference) => setPreference(value),
    },
    onMenuCommand,
  };
}
