import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createEpisodeProject,
  forgetRecentProject,
  listRecentProjects,
  openEpisodeProject,
  pickEpisodeProject,
  type RecentProject,
} from "../../api";
import { desktopCloseGuardArmed } from "../../desktop/useDesktopCloseGuard";
import { HelpDialog } from "../../home/HelpDialog";
import { useWindowFileDrop } from "../../hooks/useWindowFileDrop";
import { ingestIntoNewProject, pickAudioFiles } from "../../ingest/ingestFiles";
import { ModelsDialog, useModels } from "../../models";
import { HostMcpDialog } from "../../stage/dialogs/HostMcpDialog";
import type { ProjectCardData } from "../../system/ProjectCard";
import { ApiError, errorMessage } from "../../utils/apiError";
import {
  dismissHomeScreenHint,
  homeScreenHintDismissed,
  offersHomeScreenHint,
  readHomeScreenEnv,
} from "../../utils/homeScreenHint";
import { writeOpenIntent } from "../../utils/openIntent";
import { OPEN_OTHER_QUERY_PARAM, projectUrl } from "../../utils/projectUrl";
import { readLocal, writeLocal } from "../../utils/storage";
import { HomeView } from "./HomeView";
import {
  bundleToGet,
  cardsOf,
  episodeNameFromFiles,
  importingLine,
  setupOf,
  untitledEpisodeName,
} from "./homeModel";
import { NOT_AN_EPISODE, type OpenOtherProps } from "./OpenOther";

/** The first-run Setup card is dismissed for good once the person says "Not now". */
export const SETUP_DISMISSED_KEY = "sharecut.bootstrap.skip";

const SWITCH_BLOCKED =
  "Return to the recording project and stop the room before switching projects.";
const NOT_OPENED = "That episode didn't open. Try again.";
const NOT_STARTED = "The episode didn't start. Try again.";
const NO_PICKER =
  "Choose the moved folder with Open other…, then it replaces this card.";
/** Codes the server gives a folder that is not an episode, or is gone. */
const NOT_AN_EPISODE_CODES = new Set([
  "project_path_invalid",
  "project_not_found",
  "project_file_missing",
]);

function navigateToProject(path: string): void {
  window.location.assign(projectUrl(window.location.href, path));
}

/** Plain words with a fix for a failed open; the server's own text never shows. */
function openFailure(error: unknown): string {
  if (error instanceof ApiError && error.code) {
    if (NOT_AN_EPISODE_CODES.has(error.code)) return NOT_AN_EPISODE;
  }
  return NOT_OPENED;
}

function wantsPathField(): boolean {
  return (
    new URLSearchParams(window.location.search).get(OPEN_OTHER_QUERY_PARAM) ===
    "1"
  );
}

/**
 * Home, wired: the recent episodes, Setup from the models provider, Open other
 * through the OS folder picker (a path field where there is none), and the two
 * tiles that create an episode. Presentational work stays in `HomeView`.
 */
export function HomeScreen() {
  const models = useModels();
  const [recents, setRecents] = useState<RecentProject[] | null>(null);
  const [reload, setReload] = useState(0);
  const [now] = useState(() => new Date());
  const [notice, setNotice] = useState<string | undefined>();
  const [working, setWorking] = useState<string | undefined>();
  const [pathMode, setPathMode] = useState(wantsPathField);
  const [path, setPath] = useState("");
  const [pathError, setPathError] = useState<string | undefined>();
  const [setupDismissed, setSetupDismissed] = useState(
    () => readLocal(SETUP_DISMISSED_KEY) === "1",
  );
  const [hintShown, setHintShown] = useState(
    () =>
      offersHomeScreenHint(readHomeScreenEnv()) && !homeScreenHintDismissed(),
  );
  const [mcpOpen, setMcpOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [modelsOpen, setModelsOpen] = useState(false);
  const busy = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    void reload;
    listRecentProjects(controller.signal)
      .then(setRecents)
      // A failed read leaves the skeleton up; its Retry asks again.
      .catch(() => undefined);
    return () => controller.abort();
  }, [reload]);

  /** One action at a time, and none while a recording would be left behind. */
  const guarded = useCallback(
    async (run: () => Promise<void>, onError: (error: unknown) => void) => {
      if (busy.current) return;
      if (desktopCloseGuardArmed()) {
        setNotice(SWITCH_BLOCKED);
        return;
      }
      busy.current = true;
      setNotice(undefined);
      try {
        await run();
      } catch (error: unknown) {
        onError(error);
      } finally {
        busy.current = false;
        setWorking(undefined);
      }
    },
    [],
  );

  const open = useCallback(
    (target: string, stage?: ProjectCardData["stage"], replaces?: string) =>
      guarded(
        async () => {
          const out = await openEpisodeProject(target);
          if (replaces && replaces !== out.project_path) {
            await forgetRecentProject(replaces).catch(() => undefined);
          }
          if (stage) writeOpenIntent(out.project_path, { stage });
          navigateToProject(out.project_path);
        },
        (error) => {
          const message = openFailure(error);
          if (pathMode) setPathError(message);
          else setNotice(message);
        },
      ),
    [guarded, pathMode],
  );

  const pick = useCallback(
    (replaces?: string) =>
      guarded(
        async () => {
          const picked = await pickEpisodeProject();
          if ("project_path" in picked) {
            const out = await openEpisodeProject(picked.project_path);
            if (replaces && replaces !== out.project_path) {
              await forgetRecentProject(replaces).catch(() => undefined);
            }
            navigateToProject(out.project_path);
            return;
          }
          if ("unavailable" in picked && picked.unavailable) {
            if (replaces) setNotice(NO_PICKER);
            setPathMode(true);
            return;
          }
          if (picked.detail) setNotice(picked.detail);
        },
        (error) => setNotice(openFailure(error)),
      ),
    [guarded],
  );

  /** A new episode from audio: create it, upload the files, and open Prepare to process them. */
  const startFromFiles = useCallback(
    (files: File[]) =>
      guarded(
        async () => {
          if (files.length === 0) return;
          setWorking(importingLine(files.length));
          const created = await createEpisodeProject(
            "",
            episodeNameFromFiles(files, new Date()),
          );
          try {
            await ingestIntoNewProject(created.project_path, files);
          } catch (error: unknown) {
            setReload((n) => n + 1);
            setNotice(
              `${errorMessage(error)} The episode was started: open it from Recent.`,
            );
            return;
          }
          writeOpenIntent(created.project_path, {
            stage: "prepare",
            autoRun: true,
          });
          navigateToProject(created.project_path);
        },
        () => setNotice(NOT_STARTED),
      ),
    [guarded],
  );

  const onImport = useCallback(() => {
    void pickAudioFiles(true).then(startFromFiles);
  }, [startFromFiles]);

  const onRecord = useCallback(() => {
    void guarded(
      async () => {
        const created = await createEpisodeProject(
          "",
          untitledEpisodeName(new Date()),
        );
        writeOpenIntent(created.project_path, { stage: "record" });
        navigateToProject(created.project_path);
      },
      () => setNotice(NOT_STARTED),
    );
  }, [guarded]);

  const drop = useWindowFileDrop(true, (files) => void startFromFiles(files));

  const setup = setupOf(models);
  const getReady = useCallback(
    () => void models.download(bundleToGet(models.models)),
    [models],
  );
  const dismissSetup = useCallback(() => {
    writeLocal(SETUP_DISMISSED_KEY, "1");
    setSetupDismissed(true);
  }, []);

  const projects = useMemo(
    () => (recents ? cardsOf(recents, now) : []),
    [recents, now],
  );
  const phase =
    recents === null ? "loading" : recents.length ? "ready" : "empty";

  const openOther: Omit<OpenOtherProps, "onChooseFolder"> = {
    mode: pathMode ? "path" : "picker",
    path,
    error: pathError,
    defaultOpen: pathMode,
    onPathChange: (value) => {
      setPath(value);
      setPathError(undefined);
    },
    onSubmit: () => {
      if (path.trim()) void open(path.trim());
      else setPathError(NOT_AN_EPISODE);
    },
    onSwitchWindow: () => undefined,
  };

  return (
    <>
      <HomeView
        phase={phase}
        projects={projects}
        setup={setupDismissed ? null : setup}
        showInstallHint={hintShown}
        dropActive={drop.active}
        dropCount={drop.count}
        autoFocusPrimary
        notice={notice}
        working={working}
        openOther={openOther}
        onRetryLoad={() => setReload((n) => n + 1)}
        onOpenProject={(id, stage) => void open(id, stage)}
        onFindProject={(id) => void pick(id)}
        onImport={onImport}
        onRecord={onRecord}
        onOpenOther={() => void pick()}
        onGetReady={getReady}
        onChooseModels={() => setModelsOpen(true)}
        onCancelSetup={() => void models.cancel()}
        onRetrySetup={() =>
          setup?.state === "check-error" ? void models.refresh() : getReady()
        }
        onDismissSetup={dismissSetup}
        onDismissHint={() => {
          dismissHomeScreenHint();
          setHintShown(false);
        }}
        onHelp={() => setHelpOpen(true)}
        onModels={() => setModelsOpen(true)}
        onConnectAgent={() => setMcpOpen(true)}
      />
      <HostMcpDialog
        open={mcpOpen}
        onClose={() => setMcpOpen(false)}
        hasProject={false}
      />
      <ModelsDialog open={modelsOpen} onClose={() => setModelsOpen(false)} />
      <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
    </>
  );
}
