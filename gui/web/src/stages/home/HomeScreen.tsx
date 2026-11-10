import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createEpisodeProject,
  duplicateRecentProject,
  forgetRecentProject,
  listRecentProjects,
  openEpisodeProject,
  pickEpisodeProject,
  type RecentProject,
  revealRecentProject,
} from "../../api";
import { registerDawCommands } from "../../commands/register";
import { desktopCloseGuardArmed } from "../../desktop/useDesktopCloseGuard";
import { FeedbackToast } from "../../feedback/FeedbackToast";
import { HelpHost } from "../../home/HelpHost";
import { useWindowFileDrop } from "../../hooks/useWindowFileDrop";
import { ingestIntoNewProject, pickAudioFiles } from "../../ingest/ingestFiles";
import { ModelsSheet, useModels } from "../../models";
import { CommandPalette } from "../../stage/dialogs/CommandPalette";
import { HostMcpDialog } from "../../stage/dialogs/HostMcpDialog";
import { useShellAttributes } from "../../stage/frame/useShellAttributes";
import { useDawStore } from "../../state/dawStore";
import { useDaw } from "../../state/useDaw";
import type { ProjectCardData } from "../../system/ProjectCard";
import { StatusLiveRegion } from "../../ui/StatusLiveRegion";
import { ApiError, errorMessage } from "../../utils/apiError";
import {
  countHomeVisit,
  dismissHomeScreenHint,
  homeScreenHintDue,
  readHomeScreenEnv,
} from "../../utils/homeScreenHint";
import { writeOpenIntent } from "../../utils/openIntent";
import {
  EPISODE_PROJECT_FILENAME,
  RETIRED_PROJECT_FILENAME,
} from "../../utils/projectFile";
import { OPEN_OTHER_QUERY_PARAM, projectUrl } from "../../utils/projectUrl";
import { readSession, writeSession } from "../../utils/storage";
import { applySoundScanStart } from "../prepare/applySoundScanStart";
import { HomeView } from "./HomeView";
import {
  bundleToGet,
  cardsOf,
  downloadTotals,
  episodeNameFromFiles,
  importingLine,
  importStoppedLine,
  setupOf,
  toolsMissing,
  untitledEpisodeName,
} from "./homeModel";
import { NOT_AN_EPISODE, type OpenOtherProps } from "./OpenOther";
import { useHeldTotals } from "./useHeldTotals";
import { useHomeKeys } from "./useHomeKeys";
import { useSecondsLeft } from "./useSecondsLeft";

export const SETUP_DISMISSED_KEY = "sharecut.setup.notNow";

const SWITCH_BLOCKED =
  "Return to the recording project and stop the room before switching projects.";
const NOT_OPENED = "That episode didn't open. Try again.";
const NOT_STARTED = "The episode didn't start. Try again.";
const BUSY = "Finish the current step first.";
const NO_TOOLS =
  "Audio tools are missing, so an episode can't start yet. Set them up above, then try again.";
const NO_FILE_MANAGER = "This computer couldn't open its file manager.";
const NOT_REVEALED = "Studio couldn't show that folder. Try again.";
const NOT_DUPLICATED = "That episode didn't copy. Try again.";
const FOLDER_MOVED =
  "That episode's folder has moved. Find it with Open other…, or remove the card.";
const COPY_NAME_RESERVED =
  "Windows can't use this episode's name for a folder. Rename the episode, then copy it.";
const NOT_REMOVED = "That episode is still listed. Try again.";
const DUPLICATING = "Copying the episode…";
const OPENING = "Opening…";
const STARTING = "Starting an episode…";
const NO_PICKER =
  "Choose the moved folder with Open other…, then it replaces this card.";
const NOT_AN_EPISODE_CODES = new Set([
  "project_path_invalid",
  "project_not_found",
  "project_file_missing",
]);

const OLD_FILENAME_CODE = "project_old_filename";
const OLD_FILENAME = `Studio couldn't update this episode's old file name. In its folder, rename ${RETIRED_PROJECT_FILENAME} to ${EPISODE_PROJECT_FILENAME}, then open it again.`;

const NAME_RESERVED_CODE = "project_name_reserved";

function startFailure(error: unknown, name: string): string {
  if (error instanceof ApiError && error.code === NAME_RESERVED_CODE) {
    return `Windows can't use "${name}" as a folder name. Rename the file and drop it again.`;
  }
  return NOT_STARTED;
}

function revealFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "reveal_unavailable") return NO_FILE_MANAGER;
    if (NOT_AN_EPISODE_CODES.has(error.code ?? "")) return FOLDER_MOVED;
  }
  return NOT_REVEALED;
}

function duplicateFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === NAME_RESERVED_CODE) return COPY_NAME_RESERVED;
    if (NOT_AN_EPISODE_CODES.has(error.code ?? "")) return FOLDER_MOVED;
  }
  return NOT_DUPLICATED;
}

function navigateToProject(path: string): true {
  window.location.assign(projectUrl(window.location.href, path));
  return true;
}

/** Plain words with a fix for a failed open; the server's own text never shows. */
function openFailure(error: unknown): string {
  if (error instanceof ApiError && error.code === OLD_FILENAME_CODE) {
    return OLD_FILENAME;
  }
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
  useShellAttributes("home");
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
    () => readSession(SETUP_DISMISSED_KEY) === "1",
  );
  const [hintShown, setHintShown] = useState(() =>
    homeScreenHintDue(readHomeScreenEnv(), countHomeVisit()),
  );
  const { mcpOpen, modelsOpen, announcement, announcementSeq } = useDaw(
    (s) => ({
      mcpOpen: s.chrome.hostMcpDialogOpen,
      modelsOpen: s.chrome.modelsSheetOpen,
      announcement: s.statusAnnouncement,
      announcementSeq: s.statusAnnouncementSeq,
    }),
  );
  const { setHostMcpDialogOpen, setHelpDialogOpen, setModelsSheetOpen } =
    useDawStore.getState();
  const openPalette = useDawStore.getState().setCommandPaletteOpen;
  const busy = useRef(false);

  useEffect(() => {
    registerDawCommands();
  }, []);

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
          if (fromField) setReplacing(undefined);
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
    (replaces?: string) => {
      return guarded(
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
      );
    },
    [guarded],
  );

  const noTools = toolsMissing(models);

  const startFromFiles = useCallback(
    (files: File[]) => {
      if (files.length > 0 && noTools) {
        setNotice(NO_TOOLS);
        return Promise.resolve();
      }
      const name = episodeNameFromFiles(files, new Date());
      return guarded(
        async () => {
          if (files.length === 0) return undefined;
          const created = await createEpisodeProject("", name);
          await applySoundScanStart(created.project_path);
          const ingested = await ingestIntoNewProject(
            created.project_path,
            files,
          );
          if (ingested.failed !== undefined) {
            setReload((n) => n + 1);
            setNotice(
              importStoppedLine({
                reason: errorMessage(ingested.failed),
                added: ingested.added,
                total: files.length,
                name: created.name,
                projectPath: created.project_path,
              }),
            );
            return undefined;
          }
          writeOpenIntent(created.project_path, {
            stage: "prepare",
            autoRun: true,
          });
          return navigateToProject(created.project_path);
        },
        (error) => setNotice(startFailure(error, name)),
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
        await applySoundScanStart(created.project_path);
        writeOpenIntent(created.project_path, {
          stage: "record",
          autoRoom: true,
        });
        return navigateToProject(created.project_path);
      },
      () => setNotice(NOT_STARTED),
      STARTING,
    );
  }, [guarded, noTools]);

  const reveal = useCallback(async (id: string) => {
    try {
      await revealRecentProject(id);
    } catch (error) {
      setNotice(revealFailure(error));
    }
  }, []);

  const duplicate = useCallback(
    (id: string) =>
      guarded(
        async () => {
          await duplicateRecentProject(id);
          setReload((n) => n + 1);
          return undefined;
        },
        (error) => setNotice(duplicateFailure(error)),
        DUPLICATING,
      ),
    [guarded],
  );

  const remove = useCallback(async (id: string) => {
    setRecents((current) =>
      current ? current.filter((entry) => entry.path !== id) : current,
    );
    try {
      await forgetRecentProject(id);
    } catch {
      setNotice(NOT_REMOVED);
      setReload((n) => n + 1);
    }
  }, []);

  const drop = useWindowFileDrop(true, (files) => void startFromFiles(files));

  useHomeKeys({
    onImport,
    onRecord,
    onOpenOther: () => void pick(),
    onPalette: () => openPalette(true),
  });

  const transfer = useHeldTotals(downloadTotals(models.downloads));
  const secondsLeft = useSecondsLeft(
    transfer?.bytes ?? null,
    transfer?.total ?? null,
  );
  const setup = setupOf(models, secondsLeft, transfer);
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
    writeSession(SETUP_DISMISSED_KEY, "1");
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
    onClose: () => setReplacing(undefined),
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
        onRevealProject={(id) => void reveal(id)}
        onDuplicateProject={(id) => void duplicate(id)}
        onRemoveProject={(id) => void remove(id)}
        onImport={onImport}
        onRecord={onRecord}
        onOpenOther={() => void pick()}
        onGetReady={getReady}
        onChooseModels={() => setModelsSheetOpen(true)}
        onCancelSetup={() => void models.cancel()}
        onRetrySetup={() =>
          setup?.state === "check-error" ||
          setup?.state === "checking" ||
          setup?.state === "tools-missing"
            ? void models.refresh()
            : getReady()
        }
        onDismissSetup={dismissSetup}
        onDismissHint={() => {
          dismissHomeScreenHint();
          setHintShown(false);
        }}
        onSettings={() => setModelsSheetOpen(true)}
        onConnectAgent={() => setHostMcpDialogOpen(true)}
        onHelp={() => setHelpDialogOpen(true, "menu")}
      />
      <CommandPalette scope="home" />
      <HostMcpDialog
        open={mcpOpen}
        onClose={() => setHostMcpDialogOpen(false)}
        hasProject={false}
      />
      <ModelsSheet
        open={modelsOpen}
        onClose={() => setModelsSheetOpen(false)}
      />
      <HelpHost />
      <FeedbackToast />
      <StatusLiveRegion message={announcement} seq={announcementSeq} />
    </>
  );
}
