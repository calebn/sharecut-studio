import { isTauri } from "@tauri-apps/api/core";
import { useState } from "react";
import { revealProject } from "../api";
import { useTheme } from "../hooks/useTheme";
import { useViewportClass } from "../hooks/useViewportClass";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import { errorMessage } from "../utils/apiError";
import { SettingsSheet } from "./SettingsSheet";

/** The folder that holds a project file, for either path separator. */
function parentFolder(projectPath: string): string {
  return projectPath.replace(/[\\/][^\\/]*$/, "");
}

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
  const [revealing, setRevealing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) {
      setRevealing(false);
      setError(null);
    }
  }
  const { setSettingsSheetOpen, setModelsSheetOpen, setCommandPaletteOpen } =
    useDawStore.getState();
  const reveal = () => {
    setRevealing(true);
    setError(null);
    revealProject(projectPath)
      .catch((err: unknown) => setError(errorMessage(err)))
      .finally(() => setRevealing(false));
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
              onReveal: isTauri() ? reveal : undefined,
              revealing,
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
