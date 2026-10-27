import {
  addTrackCommand,
  closeEpisodeProject,
  openEpisodeProject,
  pickEpisodeProject,
  removeTrackCommand,
  reorderTrackCommand,
  replyHistoryHead,
} from "../api";
import { desktopCloseGuardArmed } from "../desktop/useDesktopCloseGuard";
import { redisplayDrafts } from "../document/applyDocumentUpdate";
import { currentDocumentSeq } from "../document/cursor";
import { revertOptimisticIfUnchanged } from "../document/optimisticRevert";
import { askConfirm } from "../feedback/ask";
import { canIngestMedia, isShareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { selectedTrackIdsOf } from "../state/selection";
import { withAbortTimeout } from "../utils/abortTimeout";
import { errorMessage } from "../utils/apiError";
import { homeUrl, projectUrl } from "../utils/projectUrl";
import { registerCommand } from "./execute";
import { enqueueTrackMutate } from "./trackMutation";
import type { ExecuteResult } from "./types";

const PROJECT_SWITCH_BLOCKED =
  "Stop and finish recording before switching projects";

let projectOpenInFlight = false;
let projectNewInFlight = false;
/** Studio New stops waiting for the unpin after this long and stays open. */
export const PROJECT_CLOSE_TIMEOUT_MS = 10_000;
/** If the page is still here this long after navigating Home (a leave-page prompt answered Stay), New works again. */
export const PROJECT_NEW_RETRY_MS = 5_000;
export function _resetProjectOpenInFlightForTests(): void {
  projectOpenInFlight = false;
  projectNewInFlight = false;
}
function resolveInspectorTrackId(args: Record<string, unknown>): string | null {
  if (typeof args.trackId === "string" && args.trackId) {
    return args.trackId;
  }
  const s = useDawStore.getState();
  return s.selection?.kind === "track" ? s.selection.trackId : null;
}

function moveSelectedTrack(
  args: Record<string, unknown>,
  direction: -1 | 1,
): Promise<ExecuteResult> {
  const invoked = useDawStore.getState();
  const trackId =
    invoked.selection?.kind === "track" ? invoked.selection.trackId : null;
  const projectPath = invoked.projectPath;
  return enqueueTrackMutate(async () => {
    const s = useDawStore.getState();
    if (
      !trackId ||
      s.selection?.kind !== "track" ||
      s.selection.trackId !== trackId ||
      s.projectPath !== projectPath ||
      (args.trackId !== undefined && args.trackId !== trackId) ||
      !s.project
    ) {
      return { status: "disabled", reason: "Track selection changed" };
    }
    const current = s.project.tracks.findIndex((t) => t.id === trackId);
    const next = current + direction;
    if (current < 0 || next < 0 || next >= s.project.tracks.length) {
      return {
        status: "disabled",
        reason: direction < 0 ? "Already at top" : "Already at bottom",
      };
    }
    return applyTrackReorder(trackId, next);
  });
}
async function applyTrackReorder(
  trackId: string,
  index: number,
): Promise<ExecuteResult> {
  const s = useDawStore.getState();
  if (!canIngestMedia(s.projectPath, s.guestMode, s.shareCapabilities)) {
    return { status: "disabled", reason: "Media ingest not allowed" };
  }
  if (!Number.isFinite(index) || !Number.isInteger(index)) {
    return { status: "disabled", reason: "index must be an integer" };
  }
  const previous = s.projectEditBasis();
  if (!previous?.tracks.some((t) => t.id === trackId)) {
    return { status: "disabled", reason: "Unknown track" };
  }
  const seqAtStart = currentDocumentSeq();
  // The command begins its draft before it first awaits, so showing the drafts
  // now shows the new order at once.
  const sending = reorderTrackCommand(s.projectPath, trackId, index);
  redisplayDrafts();
  const optimistic = useDawStore.getState().project;
  try {
    const reply = await sending;
    useDawStore.getState().announceStatus("Reordered track", {
      undo: replyHistoryHead(reply),
    });
    return { status: "ok" };
  } catch (e) {
    if (optimistic)
      revertOptimisticIfUnchanged(
        previous,
        seqAtStart,
        s.projectPath,
        optimistic,
      );
    const msg = errorMessage(e);
    useDawStore
      .getState()
      .announceStatus(`Reorder failed: ${msg}`, { tone: "error" });
    return { status: "disabled", reason: msg };
  }
}
function closeProjectAndGoHome(failure: string): ExecuteResult {
  if (desktopCloseGuardArmed()) {
    useDawStore
      .getState()
      .announceStatus(PROJECT_SWITCH_BLOCKED, { tone: "error" });
    return { status: "disabled", reason: PROJECT_SWITCH_BLOCKED };
  }
  if (projectNewInFlight) {
    return { status: "ok" };
  }
  projectNewInFlight = true;
  useDawStore.getState().announceStatus("Closing project…");
  const projectPath = useDawStore.getState().projectPath;
  void (async () => {
    try {
      await withAbortTimeout(
        PROJECT_CLOSE_TIMEOUT_MS,
        "Closing the project timed out",
        closeEpisodeProject,
      );
    } catch (e) {
      // Home would show while host MCP stays pinned; stay and say so.
      projectNewInFlight = false;
      useDawStore.getState().announceStatus(`${failure}: ${errorMessage(e)}`, {
        tone: "error",
      });
      // A timed-out close may still land on the server; re-pin what Studio shows.
      if (
        e instanceof DOMException &&
        e.name === "TimeoutError" &&
        projectPath &&
        !isShareProjectKey(projectPath)
      ) {
        void openEpisodeProject(projectPath).catch(() => undefined);
      }
      return;
    }
    window.location.assign(homeUrl(window.location.href));
    setTimeout(() => {
      projectNewInFlight = false;
    }, PROJECT_NEW_RETRY_MS);
  })();
  return { status: "ok" };
}

export function registerProjectMediaCommands(): void {
  registerCommand("project.new", () =>
    closeProjectAndGoHome("New project failed"),
  );

  registerCommand("project.home", () =>
    closeProjectAndGoHome("Closing the project failed"),
  );

  registerCommand("project.open", () => {
    if (desktopCloseGuardArmed()) {
      useDawStore
        .getState()
        .announceStatus(PROJECT_SWITCH_BLOCKED, { tone: "error" });
      return { status: "disabled", reason: PROJECT_SWITCH_BLOCKED };
    }
    if (projectOpenInFlight) {
      return { status: "ok" };
    }
    projectOpenInFlight = true;
    void (async () => {
      try {
        let path: string | null = null;
        try {
          const picked = await pickEpisodeProject();
          if ("cancelled" in picked && picked.cancelled) {
            if (picked.detail) {
              useDawStore.getState().announceStatus(picked.detail);
            }
            return;
          }
          if ("unavailable" in picked && picked.unavailable) {
            // No OS folder picker here: Home's Open other asks for the folder in a path field.
            window.location.assign(
              homeUrl(window.location.href, { openOther: true }),
            );
            return;
          } else if ("project_path" in picked) {
            path = picked.project_path;
          }
        } catch (err) {
          const reason = errorMessage(err);
          useDawStore
            .getState()
            .announceStatus(`Open failed: ${reason}`, { tone: "error" });
          return;
        }
        if (!path?.trim()) {
          return;
        }
        if (desktopCloseGuardArmed()) {
          useDawStore
            .getState()
            .announceStatus(PROJECT_SWITCH_BLOCKED, { tone: "error" });
          return;
        }
        try {
          const out = await openEpisodeProject(path.trim());
          if (desktopCloseGuardArmed()) {
            useDawStore
              .getState()
              .announceStatus(PROJECT_SWITCH_BLOCKED, { tone: "error" });
            return;
          }
          window.location.assign(
            projectUrl(window.location.href, out.project_path),
          );
        } catch (err) {
          const reason = errorMessage(err);
          useDawStore
            .getState()
            .announceStatus(`Open failed: ${reason}`, { tone: "error" });
        }
      } finally {
        projectOpenInFlight = false;
      }
    })();
    return { status: "ok" };
  });

  registerCommand("track.add", async () => {
    const s = useDawStore.getState();
    if (!canIngestMedia(s.projectPath, s.guestMode, s.shareCapabilities)) {
      return { status: "disabled", reason: "Media ingest not allowed" };
    }
    await addTrackCommand(s.projectPath, {});
    return { status: "ok" };
  });

  registerCommand("track.remove", async (args) => {
    const asked = useDawStore.getState();
    if (
      !canIngestMedia(
        asked.projectPath,
        asked.guestMode,
        asked.shareCapabilities,
      )
    ) {
      return { status: "disabled", reason: "Media ingest not allowed" };
    }
    const trackId = resolveInspectorTrackId(args);
    if (!trackId) {
      return { status: "disabled", reason: "No track selected in inspector" };
    }
    if (
      typeof args.trackId !== "string" &&
      selectedTrackIdsOf(asked.selection).length > 1
    ) {
      return { status: "disabled", reason: "Select one track to remove" };
    }
    const label =
      asked.project?.tracks.find((t) => t.id === trackId)?.label || trackId;
    const confirmed = await askConfirm({
      title: `Remove the ${label} track?`,
      message: "Its clips leave the timeline.",
      keepLabel: "Keep track",
      actionLabel: "Remove track",
      danger: true,
    });
    if (!confirmed) {
      return { status: "disabled", reason: "Cancelled" };
    }
    return enqueueTrackMutate(async () => {
      const s = useDawStore.getState();
      if (
        s.projectPath !== asked.projectPath ||
        !s.project?.tracks.some((t) => t.id === trackId)
      ) {
        return { status: "disabled", reason: "Unknown track" };
      }
      try {
        const reply = await removeTrackCommand(s.projectPath, trackId);
        useDawStore.getState().announceStatus(`Removed ${label}`, {
          undo: replyHistoryHead(reply),
        });
        const next = useDawStore.getState();
        next.setSelection(null);
        return { status: "ok" };
      } catch (e) {
        const msg = errorMessage(e);
        useDawStore
          .getState()
          .announceStatus(`Remove failed: ${msg}`, { tone: "error" });
        return { status: "disabled", reason: msg };
      }
    });
  });

  registerCommand("track.reorder", async (args) => {
    return enqueueTrackMutate(async () => {
      const trackId = resolveInspectorTrackId(args);
      if (!trackId) {
        return { status: "disabled", reason: "No track selected in inspector" };
      }
      return applyTrackReorder(trackId, Number(args.index));
    });
  });

  registerCommand("track.moveUp", async (args) => {
    return moveSelectedTrack(args, -1);
  });

  registerCommand("track.moveDown", async (args) => {
    return moveSelectedTrack(args, 1);
  });

  registerCommand("media.import", async (args) => {
    const s = useDawStore.getState();
    if (!canIngestMedia(s.projectPath, s.guestMode, s.shareCapabilities)) {
      return { status: "disabled", reason: "Media ingest not allowed" };
    }
    const { ingestFiles, pickAudioFiles } = await import(
      "../ingest/ingestFiles"
    );
    const files = await pickAudioFiles(true);
    if (!files.length) {
      return { status: "disabled", reason: "No files selected" };
    }
    const trackId =
      typeof args.trackId === "string"
        ? args.trackId
        : s.selection?.kind === "track"
          ? s.selection.trackId
          : null;
    await ingestFiles(
      files,
      trackId ? { kind: "track", id: trackId } : { kind: "new" },
    );
    return { status: "ok" };
  });
}
