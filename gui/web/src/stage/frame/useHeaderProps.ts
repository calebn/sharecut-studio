import { useCallback, useState } from "react";
import { runPointerCommand } from "../../commands/pointer";
import { useRenameProject } from "../../hooks/useRenameProject";
import { useReviewPeaks } from "../../hooks/useReviewPeaks";
import { useReviewVersion } from "../../hooks/useReviewVersion";
import { type ThemePreference, useTheme } from "../../hooks/useTheme";
import { useDawStore } from "../../state/dawStore";
import { stageRoleOf } from "../../state/stageRoutes";
import { useDaw } from "../../state/useDaw";
import type { AppHeaderProps } from "../../system/AppHeader";
import { isHostRole } from "../../utils/can";
import {
  markRoleHintSeen,
  ROLE_HINT_TEXT,
  roleHintSeen,
} from "../../utils/roleHint";
import { useHistoryControls } from "./useHistoryControls";
import { useSaveIndicator } from "./useSaveIndicator";
import { useStageBarProps } from "./useStageBarProps";

const reloadPage = () => window.location.reload();

/** The Project menu rows the header reports, and the command each one runs. Help opens its sheet at the three rows. */
const MENU_COMMANDS: Record<string, string> = {
  projects: "project.home",
  settings: "settings.open",
  agent: "mcp.connect",
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
  const { title, guestMode, shell } = useDaw((s) => ({
    title: s.project?.meta.name ?? null,
    guestMode: s.guestMode,
    shell: s.shellBreakpoint,
  }));
  const onRename = useRenameProject();
  const save = useSaveIndicator();
  const version = useReviewVersion();
  useReviewPeaks(version);
  const history = useHistoryControls();
  const stages = useStageBarProps();
  const { preference, setPreference } = useTheme();
  const role = stageRoleOf(guestMode);
  const [dismissed, setDismissed] = useState<readonly string[]>([]);
  const guest: AppHeaderProps["guest"] = isHostRole(role)
    ? undefined
    : {
        version: version?.label ?? "Shared link",
        followsLatest: version?.followsLatest,
        update: version?.changed
          ? {
              id: version.versionId,
              label: version.label,
              onListen: reloadPage,
            }
          : undefined,
        role,
        compact: shell === "phone",
        hint: {
          text: ROLE_HINT_TEXT[role],
          shown: !dismissed.includes(role) && !roleHintSeen(role),
          onDismiss: () => {
            markRoleHintSeen(role);
            setDismissed((current) => [...current, role]);
          },
        },
      };
  const onMenuCommand = useCallback((command: string) => {
    if (command === "help") {
      useDawStore.getState().setHelpDialogOpen(true, "menu");
      return;
    }
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
    guest,
    canUndo: history.history?.canUndo ?? false,
    canRedo: history.history?.canRedo ?? false,
    onUndo: history.onUndo,
    onRedo: history.onRedo,
    onInvite: () => runPointerCommand("share.manage"),
    onPalette: () => runPointerCommand("ui.toggleCommandPalette"),
    onRename: isHostRole(role) ? onRename : undefined,
    onHistory: history.history ? onHistory : undefined,
    appearance: {
      value: preference,
      onChange: (value: ThemePreference) => setPreference(value),
    },
    onMenuCommand,
  };
}
