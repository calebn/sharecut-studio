import { useCallback, useState } from "react";
import {
  createEpisodeProject,
  openEpisodeProject,
  pickEpisodeProject,
} from "../api";
import { desktopCloseGuardArmed } from "../desktop/useDesktopCloseGuard";
import { HostMcpDialog } from "../layout/HostMcpDialog";
import { ModelsDialog, useModels } from "../models";
import { errorMessage } from "../utils/apiError";
import { projectUrl } from "../utils/projectUrl";
import { readLocal, writeLocal } from "../utils/storage";
import { BootstrapWizard } from "./BootstrapWizard";
import { HelpDialog } from "./HelpDialog";
import { HomeScreenView } from "./HomeScreenView";

const SKIP_KEY = "sharecut.bootstrap.skip";

function navigateToProject(path: string): void {
  window.location.assign(projectUrl(window.location.href, path));
}

function bootstrapSkipped(): boolean {
  return readLocal(SKIP_KEY) === "1";
}

export function HomeScreen() {
  const [setupDone, setSetupDone] = useState(() => bootstrapSkipped() || false);
  const [mode, setMode] = useState<"idle" | "new" | "open">("idle");
  const [name, setName] = useState("episode");
  const [dir, setDir] = useState("");
  const [path, setPath] = useState("");
  const [busyAction, setBusyAction] = useState<
    "create" | "open" | "browse" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [mcpOpen, setMcpOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const { models, ready } = useModels();

  const markReady = useCallback(() => {
    setSetupDone(true);
  }, []);

  const onSkip = useCallback(() => {
    writeLocal(SKIP_KEY, "1");
    setSetupDone(true);
  }, []);

  const canSwitchProject = () => {
    if (desktopCloseGuardArmed()) {
      setError(
        "Return to the recording project and stop the room before switching projects.",
      );
      return false;
    }
    return true;
  };

  const onCreate = async () => {
    if (!canSwitchProject()) return;
    setBusyAction("create");
    setError(null);
    try {
      const out = await createEpisodeProject(
        dir.trim(),
        name.trim() || "episode",
      );
      navigateToProject(out.project_path);
    } catch (e: unknown) {
      setError(errorMessage(e));
      setBusyAction(null);
    }
  };

  const onOpen = async () => {
    if (!canSwitchProject()) return;
    setBusyAction("open");
    setError(null);
    try {
      const out = await openEpisodeProject(path.trim());
      navigateToProject(out.project_path);
    } catch (e: unknown) {
      setError(errorMessage(e));
      setBusyAction(null);
    }
  };

  const onBrowse = async () => {
    if (!canSwitchProject()) return;
    setBusyAction("browse");
    setError(null);
    try {
      const picked = await pickEpisodeProject();
      if ("cancelled" in picked && picked.cancelled) {
        if (picked.detail) {
          setError(picked.detail);
        }
        setBusyAction(null);
        return;
      }
      if ("unavailable" in picked && picked.unavailable) {
        setError(
          picked.detail ||
            "No OS file dialog available; paste the path to episode.project.json.",
        );
        setBusyAction(null);
        return;
      }
      if (!("project_path" in picked)) {
        setBusyAction(null);
        return;
      }
      setPath(picked.project_path);
      const out = await openEpisodeProject(picked.project_path);
      navigateToProject(out.project_path);
    } catch (e: unknown) {
      setError(errorMessage(e));
      setBusyAction(null);
    }
  };

  return (
    <HomeScreenView
      wizard={
        setupDone ? null : (
          <BootstrapWizard onReady={markReady} onSkip={onSkip} />
        )
      }
      mode={mode}
      name={name}
      dir={dir}
      path={path}
      busyAction={busyAction}
      error={error}
      modelsIncomplete={models !== null && !ready}
      dialogs={
        <>
          <HostMcpDialog
            open={mcpOpen}
            onClose={() => setMcpOpen(false)}
            hasProject={false}
          />
          <ModelsDialog
            open={modelsOpen}
            onClose={() => setModelsOpen(false)}
          />
          <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
        </>
      }
      onNameChange={setName}
      onDirChange={setDir}
      onPathChange={setPath}
      onNewMode={() => setMode("new")}
      onOpenMode={() => setMode("open")}
      onCancel={() => setMode("idle")}
      onCreate={() => void onCreate()}
      onOpen={() => void onOpen()}
      onBrowse={() => void onBrowse()}
      onConnectAgent={() => setMcpOpen(true)}
      onModels={() => setModelsOpen(true)}
      onHelp={() => setHelpOpen(true)}
    />
  );
}
