import { isTauri } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { executePointerCommand } from "../commands/pointer";
import { registerProjectMediaCommands } from "../commands/projectMedia";
import { useDawStore } from "../state/dawStore";
import {
  drainOpenProjectQueue,
  OPEN_PROJECT_FILE_EVENT,
  takeBootProjectFile,
} from "./openProjectFile";

function openProjectFile(path: string): void {
  if (useDawStore.getState().projectPath === path) return;
  void executePointerCommand("project.open", { path });
}

/** Opens .sharecut files the desktop app hands over: at launch, or while it runs. */
export function OpenProjectFileHost() {
  useEffect(() => {
    if (!isTauri()) return;
    // The host mounts before Home or the editor register their commands; registering is idempotent.
    registerProjectMediaCommands();
    const drain = () => {
      for (const path of drainOpenProjectQueue()) openProjectFile(path);
    };
    const boot = takeBootProjectFile();
    if (boot) openProjectFile(boot);
    drain();
    window.addEventListener(OPEN_PROJECT_FILE_EVENT, drain);
    return () => window.removeEventListener(OPEN_PROJECT_FILE_EVENT, drain);
  }, []);
  return null;
}
