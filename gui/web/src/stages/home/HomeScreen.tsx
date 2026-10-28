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
  toolsMissing,
  untitledEpisodeName,
} from "./homeModel";
import { NOT_AN_EPISODE, type OpenOtherProps } from "./OpenOther";

export const SETUP_DISMISSED_KEY = "sharecut.bootstrap.skip";

const SWITCH_BLOCKED =
  "Return to the recording project and stop the room before switching projects.";
const NOT_OPENED = "That episode didn't open. Try again.";
const NOT_STARTED = "The episode didn't start. Try again.";
const BUSY = "Finish the current step first.";
const NO_TOOLS =
  "Audio tools are missing, so an episode can't start yet. Set them up above, then try again.";
const OPENING = "Opening…";
const STARTING = "Starting an episode…";
const NO_PICKER =
  "Choose the moved folder with Open other…, then it replaces this card.";
const NOT_AN_EPISODE_CODES = new Set([
  "project_path_invalid",
  "project_not_found",
  "project_file_missing",
]);

function navigateToProject(path: string): true {
  window.location.assign(projectUrl(window.location.href, path));
  return true;
}

/** Plain words with a fix for a failed open; the server's own text never shows. */
function openFailure(error: unknown): string {
  if (error instanceof ApiError && NOT_AN_EPISODE_CODES.has(error.code ?? "")) {
    return NOT_AN_EPISODE;
  }
  return NOT_OPENED;
}

async function forgetReplaced(
  replaces: string | undefined,
  opened: string,
): Promise<void> {
  if (replaces && replaces !== opened) {
    await forgetRecentProject(replaces).catch(() => undefined);
  }
}

function wantsPathField(): boolean {
  return (
    new URLSearchParams(window.location.search).get(OPEN_OTHER_QUERY_PARAM) ===
    "1"
  );
}

export function HomeScreen() {
  const models = useModels();
  const [recents, setRecents] = useState<RecentProject[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [now] = useState(() => new Date());
  const [notice, setNotice] = useState<string | undefined>();
  const [working, setWorking] = useState<string | undefined>();
  const [busyId, setBusyId] = useState<string | undefined>();
  const [pathMode, setPathMode] = useState(wantsPathField);
  const [path, setPath] = useState("");
  const [pathError, setPathError] = useState<string | undefined>();
  const [replacing, setReplacing] = useState<string | undefined>();
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
    setLoadFailed(false);
    listRecentProjects(controller.signal)
      .then(setRecents)
      .catch(() => {
        if (!controller.signal.aborted) setLoadFailed(true);
      });
    return () => controller.abort();
  }, [reload]);

  useEffect(() => {
    const restored = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      busy.current = false;
      setWorking(undefined);
      setBusyId(undefined);
      setReload((n) => n + 1);
    };
    window.addEventListener("pageshow", restored);
    return () => window.removeEventListener("pageshow", restored);
  }, []);

  /** One action at a time, and none while a recording would be left behind. */
  const guarded = useCallback(
    async (
      run: () => Promise<boolean | undefined>,
      onError: (error: unknown) => void,
      label?: string,
      cardId?: string,
    ) => {
      if (busy.current) {
        setNotice(BUSY);
        return;
      }
      if (desktopCloseGuardArmed()) {
        setNotice(SWITCH_BLOCKED);
        return;
      }
      busy.current = true;
      setNotice(undefined);
      setWorking(label);
      setBusyId(cardId);
      let leaving = false;
      try {
        leaving = (await run()) === true;
      } catch (error: unknown) {
        onError(error);
      } finally {
        if (!leaving) {
          busy.current = false;
          setWorking(undefined);
          setBusyId(undefined);
        }
        setNotice((now) => (now === BUSY ? undefined : now));
      }
    },
    [],
  );

  const open = useCallback(
    (
      target: string,
      stage?: ProjectCardData["stage"],
      replaces?: string,
      fromField = false,
    ) =>
      guarded(
        async () => {
          const out = await openEpisodeProject(target);
          await forgetReplaced(replaces, out.project_path);
          if (stage) writeOpenIntent(out.project_path, { stage });
          return navigateToProject(out.project_path);
        },
        (error) => {
          const message = openFailure(error);
          if (fromField) setPathError(message);
          else setNotice(message);
        },
        OPENING,
        fromField ? undefined : target,
      ),
    [guarded],
  );

  const pick = useCallback(
    (replaces?: string) =>
      guarded(
        async () => {
          const picked = await pickEpisodeProject();
          if ("project_path" in picked) {
            const out = await openEpisodeProject(picked.project_path);
            await forgetReplaced(replaces, out.project_path);
            return navigateToProject(out.project_path);
          }
          if ("unavailable" in picked && picked.unavailable) {
            if (replaces) setNotice(NO_PICKER);
            setReplacing(replaces);
            setPathMode(true);
            return;
          }
          if (picked.detail) setNotice(picked.detail);
          return undefined;
        },
        (error) => setNotice(openFailure(error)),
        OPENING,
      ),
    [guarded],
  );

  const noTools = toolsMissing(models);

  const startFromFiles = useCallback(
    (files: File[]) => {
      if (files.length > 0 && noTools) {
        setNotice(NO_TOOLS);
        return Promise.resolve();
      }
      return guarded(
        async () => {
          if (files.length === 0) return undefined;
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
            return undefined;
          }
          writeOpenIntent(created.project_path, {
            stage: "prepare",
            autoRun: true,
          });
          return navigateToProject(created.project_path);
        },
        () => setNotice(NOT_STARTED),
        importingLine(files.length),
      );
    },
    [guarded, noTools],
  );

  const onImport = useCallback(() => {
    if (noTools) {
      setNotice(NO_TOOLS);
      return;
    }
    void pickAudioFiles(true).then((files) => {
      if (files.length > 0) void startFromFiles(files);
    });
  }, [startFromFiles, noTools]);

  const onRecord = useCallback(() => {
    if (noTools) {
      setNotice(NO_TOOLS);
      return;
    }
    void guarded(
      async () => {
        const created = await createEpisodeProject(
          "",
          untitledEpisodeName(new Date()),
        );
        writeOpenIntent(created.project_path, { stage: "record" });
        return navigateToProject(created.project_path);
      },
      () => setNotice(NOT_STARTED),
      STARTING,
    );
  }, [guarded, noTools]);

  const drop = useWindowFileDrop(true, (files) => void startFromFiles(files));

  const setup = setupOf(models);
  const getReady = useCallback(
    () => void models.download(bundleToGet(models.models)),
    [models],
  );
  const hideSetup =
    setupDismissed &&
    setup?.state !== "downloading" &&
    setup?.state !== "failed" &&
    setup?.state !== "tools-missing";
  const dismissSetup = useCallback(() => {
    writeLocal(SETUP_DISMISSED_KEY, "1");
    setSetupDismissed(true);
  }, []);

  const projects = useMemo(
    () => (recents ? cardsOf(recents, now) : []),
    [recents, now],
  );
  let phase: "loading" | "error" | "empty" | "ready" = "loading";
  if (recents) phase = recents.length ? "ready" : "empty";
  else if (loadFailed) phase = "error";

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
      if (path.trim()) void open(path.trim(), undefined, replacing, true);
      else setPathError(NOT_AN_EPISODE);
    },
  };

  return (
    <>
      <HomeView
        phase={phase}
        projects={projects}
        setup={hideSetup ? null : setup}
        showInstallHint={hintShown}
        dropActive={drop.active}
        dropCount={drop.count}
        autoFocusPrimary
        notice={notice}
        working={working}
        busyId={busyId}
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
          setup?.state === "check-error" || setup?.state === "tools-missing"
            ? void models.refresh()
            : getReady()
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
