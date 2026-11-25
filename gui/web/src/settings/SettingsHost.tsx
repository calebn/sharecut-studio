import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import {
  moveProject,
  pickFolder,
  revealProject,
  setJoinFadeLimitCommand,
} from "../api";
import { runPointerCommand } from "../commands/pointer";
import { desktopCloseGuardArmed } from "../desktop/useDesktopCloseGuard";
import { useProjectMutation } from "../hooks/useProjectMutation";
import { useTheme } from "../hooks/useTheme";
import { useViewportClass } from "../hooks/useViewportClass";
import { loadHostCommandCount } from "../services/offlineQueue/offlineStore";
import { canApplyPass12 } from "../shareMode";
import {
  MOVE_IN_PROGRESS,
  MOVE_WAIT_FOR_EDITS,
  withHostMove,
} from "../state/commandSendOwnership";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import { ApiError, errorMessage } from "../utils/apiError";
import { projectUrl } from "../utils/projectUrl";
import { SettingsSheet } from "./SettingsSheet";

/** The folder that holds a project file, for either path separator. */
function parentFolder(projectPath: string): string {
  return projectPath.replace(/[\\/][^\\/]*$/, "");
}

const PARTIAL_MOVE_CODE = "project_moved_partial";
const MOVE_REFUSAL_CODES = new Set<string | null>([
  "move_busy_jobs",
  "move_cross_volume",
  "move_dest_exists",
  "move_dest_invalid",
  "move_failed",
  "move_in_use",
  "move_others_connected",
  "move_room_open",
  "project_busy",
]);
const MOVE_RECORDING_OPEN =
  "Stop the recording room before moving this episode.";
const MOVE_CHECK_FAILED =
  "Couldn't check whether all edits are saved. Keep this episode open and try Move again when editing has finished.";
const MOVE_PICK_FAILED =
  "Couldn't open the selected folder. The move hasn't started. Try Move again.";
const MOVE_UNCONFIRMED =
  "Couldn't confirm where this episode is. Check the folder you chose and the original folder before trying again.";
const JOIN_FADE_LIMIT_READ_ONLY =
  "This link can view, but not change, episode settings. Ask the host for an editor link.";

type MoveFailure = {
  opening: symbol | null;
  message: string;
};

function refuseWhileRecording(): void {
  if (desktopCloseGuardArmed()) throw new Error(MOVE_RECORDING_OPEN);
}

async function refuseWhileEditsQueued(projectPath: string): Promise<void> {
  if ((await loadHostCommandCount(projectPath)) > 0) {
    throw new Error(MOVE_WAIT_FOR_EDITS);
  }
}

function moveErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError && MOVE_REFUSAL_CODES.has(error.code)) {
    return errorMessage(error);
  }
  if (
    error instanceof Error &&
    (error.message === MOVE_WAIT_FOR_EDITS ||
      error.message === MOVE_IN_PROGRESS ||
      error.message === MOVE_RECORDING_OPEN)
  ) {
    return error.message;
  }
  return fallback;
}

function partialMoveDestination(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.code !== PARTIAL_MOVE_CODE) {
    return null;
  }
  const detail = (error.body as { detail?: { project_path?: unknown } } | null)
    ?.detail;
  return typeof detail?.project_path === "string" && detail.project_path.trim()
    ? detail.project_path
    : null;
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
  const limit = useProjectMutation();
  const limitMs = useDaw((s) => s.project?.clips.join_fade_limit_ms ?? null);
  const limitDefaultMs = useDaw(
    (s) => s.project?.clips.join_fade_limit_default_ms,
  );
  const canEdit = useDaw((s) =>
    canApplyPass12(s.projectPath, s.guestMode, s.shareCapabilities),
  );
  const [limitDraft, setLimitDraft] = useState<number | null>(null);
  // The draft shows the saved value until the episode's clips catch up with it.
  if (limitDraft !== null && limitDraft === limitMs) setLimitDraft(null);
  const [moveOpening, setMoveOpening] = useState<symbol | null>(() =>
    open ? Symbol("settings-move-feedback") : null,
  );
  const [moveFailure, setMoveFailure] = useState<MoveFailure | null>(null);
  const moveError =
    moveOpening !== null && moveFailure?.opening === moveOpening
      ? moveFailure.message
      : null;
  const error = reveal.error ?? moveError;
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
    setMoveOpening(open ? Symbol("settings-move-feedback") : null);
    if (!open) {
      reveal.setError(null);
      setMoveFailure(null);
      limit.setError(null);
    }
  }
  const {
    setSettingsSheetOpen,
    setModelsSheetOpen,
    setSegmentLibraryOpen,
    setCommandPaletteOpen,
  } = useDawStore.getState();
  const revealFolder = () => {
    setMoveFailure(null);
    void reveal.run(() => revealProject(projectPath));
  };
  // A move reloads the page at the new path, so the sheet never shows a stale folder.
  const moveFolder = () => {
    const opening = moveOpening;
    reveal.setError(null);
    setMoveFailure(null);
    void mover.run(async () => {
      let fallback = MOVE_CHECK_FAILED;
      try {
        refuseWhileRecording();
        await refuseWhileEditsQueued(projectPath);
        refuseWhileRecording();
        fallback = MOVE_PICK_FAILED;
        const picked = await pickFolder();
        if ("unavailable" in picked) {
          setMoveFailure({
            opening,
            message:
              "This computer couldn't open a folder dialog, so the episode stays where it is.",
          });
          return;
        }
        if ("cancelled" in picked) return;
        fallback = MOVE_CHECK_FAILED;
        const destination = await withHostMove(projectPath, async () => {
          await refuseWhileEditsQueued(projectPath);
          refuseWhileRecording();
          fallback = MOVE_UNCONFIRMED;
          try {
            const moved = await moveProject(
              projectPath,
              picked.folder,
              localClientId,
            );
            if (
              typeof moved.project_path !== "string" ||
              !moved.project_path.trim()
            ) {
              throw new Error("Missing project path in move response");
            }
            return moved.project_path;
          } catch (error) {
            const destination = partialMoveDestination(error);
            if (destination === null) throw error;
            return destination;
          }
        });
        fallback = "The episode moved. Open it from the folder you chose.";
        setLeaving(true);
        window.location.assign(projectUrl(window.location.href, destination));
      } catch (error) {
        setMoveFailure({ opening, message: moveErrorMessage(error, fallback) });
      }
    });
  };
  // Setting the app default stores no value of its own, so the episode keeps following the default.
  const commitLimit = (ms: number) => {
    setLimitDraft(ms);
    void limit.run(async () => {
      try {
        await setJoinFadeLimitCommand(
          projectPath,
          ms === limitDefaultMs ? null : ms,
        );
      } catch (error) {
        setLimitDraft(null);
        throw error;
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
      joinFadeLimit={
        inProject
          ? {
              valueMs: limitDraft ?? limitMs,
              defaultMs: limitDefaultMs,
              onCommit: canEdit ? commitLimit : undefined,
              readOnlyReason: canEdit ? undefined : JOIN_FADE_LIMIT_READ_ONLY,
              saving: limit.busy,
              error: limit.error,
            }
          : undefined
      }
      onOpenModels={() => {
        setSettingsSheetOpen(false);
        setModelsSheetOpen(true);
      }}
      onOpenSegments={() => {
        setSettingsSheetOpen(false);
        setSegmentLibraryOpen(true);
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
