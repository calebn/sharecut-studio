import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { runPointerCommand } from "../../commands/pointer";
import { useRenameProject } from "../../hooks/useRenameProject";
import { useReviewPeaks } from "../../hooks/useReviewPeaks";
import { useReviewVersion } from "../../hooks/useReviewVersion";
import { type ThemePreference, useTheme } from "../../hooks/useTheme";
import { isTypingTarget } from "../../keymap/typing";
import { shareTokenFromKey } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { useReadsSavedCopy } from "../../state/savedCopy";
import { useShareName } from "../../state/shareName";
import { stageRoleOf } from "../../state/stageRoutes";
import { useDaw } from "../../state/useDaw";
import type { AppHeaderProps } from "../../system/AppHeader";
import { isHostRole } from "../../utils/can";
import {
  dismissEditStakes,
  EDIT_STAKES_TEXT,
  editStakesUp,
  markEditStakesSeen,
  subscribeEditStakes,
} from "../../utils/editStakes";
import { setRoleBubbleUp } from "../../utils/roleBubble";
import {
  markRoleHintSeen,
  ROLE_HINT_TEXT,
  roleHintSeen,
} from "../../utils/roleHint";
import { announceAfterNextStatus } from "./announceAfterNextStatus";
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
  const shareName = useShareName();
  const { name, guestMode, shell } = useDaw((s) => ({
    name: s.project?.meta.name ?? null,
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
  const savedCopy = useReadsSavedCopy();
  const role = stageRoleOf(guestMode);
  const host = isHostRole(role);
  const [dismissed, setDismissed] = useState<readonly string[]>([]);
  // The saved copy opens read-only whatever the link allows, so no role is
  // known to name or to explain.
  const showRole = !savedCopy;
  const token = useDawStore((s) => shareTokenFromKey(s.projectPath));
  const stakesRaised = useSyncExternalStore(subscribeEditStakes, editStakesUp);
  const hintRole = host ? null : role;
  const roleHintUp =
    hintRole !== null &&
    !dismissed.includes(hintRole) &&
    !roleHintSeen(hintRole);
  const hintKind = roleHintUp ? "role" : "stakes";
  const hintText =
    hintRole !== null && roleHintUp
      ? ROLE_HINT_TEXT[hintRole]
      : EDIT_STAKES_TEXT;
  const hintShown = showRole && (roleHintUp || stakesRaised);
  useEffect(() => {
    setRoleBubbleUp(hintShown);
    return () => setRoleBubbleUp(false);
  }, [hintShown]);
  const guest: AppHeaderProps["guest"] = host
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
        role: showRole ? role : undefined,
        compact: shell === "phone",
        hint: showRole
          ? {
              kind: hintKind,
              text: hintText,
              explanation:
                hintRole === null ? undefined : ROLE_HINT_TEXT[hintRole],
              shown: hintShown,
              onDismiss: () => {
                if (hintKind === "role") {
                  markRoleHintSeen(role);
                  setDismissed((current) => [...current, role]);
                } else {
                  markEditStakesSeen(token);
                  dismissEditStakes();
                }
              },
              escapeYields: (event) =>
                useDawStore.getState().feedbackToast !== null &&
                !isTypingTarget(event.target),
              // The frame's one polite live region says it; a toast would repeat the bubble.
              // The reminder rises as the edit lands, ahead of the edit's own status, which would replace it.
              onShown: () =>
                hintKind === "stakes"
                  ? announceAfterNextStatus(hintText)
                  : useDawStore
                      .getState()
                      .announceStatus(hintText, { toast: false }),
            }
          : undefined,
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
    title: name ?? shareName ?? (host ? "Project" : "Episode"),
    loading: name === null,
    save: save ?? undefined,
    stages,
    guest,
    canUndo: history.history?.canUndo ?? false,
    canRedo: history.history?.canRedo ?? false,
    undoReason: history.history?.undoReason,
    redoReason: history.history?.redoReason,
    onUndo: history.onUndo,
    onRedo: history.onRedo,
    onInvite: () => runPointerCommand("share.manage"),
    onPalette: () => runPointerCommand("ui.toggleCommandPalette"),
    onRename: host ? onRename : undefined,
    onHistory: history.history ? onHistory : undefined,
    appearance: {
      value: preference,
      onChange: (value: ThemePreference) => setPreference(value),
    },
    onMenuCommand,
  };
}
