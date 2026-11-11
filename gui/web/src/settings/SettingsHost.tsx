import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { moveProject, pickFolder, revealProject } from "../api";
import { runPointerCommand } from "../commands/pointer";
import { useProjectMutation } from "../hooks/useProjectMutation";
import { useTheme } from "../hooks/useTheme";
import { useViewportClass } from "../hooks/useViewportClass";
import { loadHostCommandCount } from "../services/offlineQueue/offlineStore";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import { ApiError } from "../utils/apiError";
import { projectUrl } from "../utils/projectUrl";
import { SettingsSheet } from "./SettingsSheet";

/** The folder that holds a project file, for either path separator. */
function parentFolder(projectPath: string): string {
  return projectPath.replace(/[\\/][^\\/]*$/, "");
}

const PARTIAL_MOVE_CODE = "project_moved_partial";

/** Where a half-finished move left the episode, from the server's refusal body. */
function movedTo(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.code !== PARTIAL_MOVE_CODE) {
    return null;
  }
  const detail = (error.body as { detail?: { project_path?: unknown } } | null)
    ?.detail;
  return typeof detail?.project_path === "string" ? detail.project_path : null;
}

/** The desktop app's native Settings… menu item (Cmd+,) dispatches this on window. */
export const OPEN_SETTINGS_EVENT = "sharecut:open-settings";

/**
 * Settings from the app menu (Home and the Project menu). Models and Keyboard
 * shortcuts close this sheet and open theirs, so two sheets are never stacked.
 */
export function SettingsHost() {
  const open = useDaw((s) => s.chrome.settingsSheetOpen);
  const projectPath = useDaw((s) => s.projectPath);
  const inProject = useDaw((s) => s.project !== null && s.projectPath !== "");
  const phone = useViewportClass() === "phone";
  const { preference, setPreference } = useTheme();
  const reveal = useProjectMutation();
  const mover = useProjectMutation();
  const error = reveal.error ?? mover.error;
  const localClientId = useDaw((s) => s.localClientId);
  // Busy ends before the page unloads; keep Move disabled until it does.
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    const openSettings = () => runPointerCommand("settings.open");
    window.addEventListener(OPEN_SETTINGS_EVENT, openSettings);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, openSettings);
  }, []);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) {
      reveal.setError(null);
      mover.setError(null);
    }
  }
  const { setSettingsSheetOpen, setModelsSheetOpen, setCommandPaletteOpen } =
    useDawStore.getState();
  const revealFolder = () => {
    mover.setError(null);
    void reveal.run(() => revealProject(projectPath));
  };
  // A move reloads the page at the new path, so the sheet never shows a stale folder.
  const moveFolder = () => {
    reveal.setError(null);
    void mover.run(async () => {
      // Edits still waiting to be saved are queued under the old path, and the
      // reload would strand them.
      if ((await loadHostCommandCount(projectPath)) > 0) {
        throw new Error(
          "Some edits are still waiting to be saved. Wait for them to finish, then move the episode.",
        );
      }
      const picked = await pickFolder();
      if ("unavailable" in picked) {
        throw new Error(
          "This computer couldn't open a folder dialog, so the episode stays where it is.",
        );
      }
      if ("cancelled" in picked) return;
      try {
        const moved = await moveProject(
          projectPath,
          picked.folder,
          localClientId,
        );
        setLeaving(true);
        window.location.assign(
          projectUrl(window.location.href, moved.project_path),
        );
      } catch (error) {
        // The folder did move: stay on the old path and the next save misses.
        const there = movedTo(error);
        if (there === null) throw error;
        setLeaving(true);
        window.location.assign(projectUrl(window.location.href, there));
      }
    });
  };
  return (
    <SettingsSheet
      open={open}
      onClose={() => setSettingsSheetOpen(false)}
      phone={phone}
      theme={preference}
      onTheme={setPreference}
      savedIn={
        inProject
          ? {
              folder: parentFolder(projectPath),
              onReveal: isTauri() ? revealFolder : undefined,
              onMove: isTauri() ? moveFolder : undefined,
              moving: mover.busy || leaving,
              revealing: reveal.busy,
              error,
            }
          : undefined
      }
      onOpenModels={() => {
        setSettingsSheetOpen(false);
        setModelsSheetOpen(true);
      }}
      onOpenShortcuts={
        inProject
          ? () => {
              setSettingsSheetOpen(false);
              setCommandPaletteOpen(true);
            }
          : undefined
      }
    />
  );
}
