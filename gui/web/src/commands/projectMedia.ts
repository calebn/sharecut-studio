import { desktopCloseGuardArmed } from "../desktop/useDesktopCloseGuard";
import { currentDocumentSeq } from "../document/cursor";
import { revertOptimisticIfUnchanged } from "../document/optimisticRevert";
import { patchTracksOrder } from "../document/projectPatch";
import { canIngestMedia } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { errorMessage } from "../utils/apiError";
import { homeUrl, projectUrl } from "../utils/projectUrl";
import { registerCommand } from "./execute";
import { enqueueTrackMutate } from "./trackMutation";
import type { ExecuteResult } from "./types";

const PROJECT_SWITCH_BLOCKED =
  "Stop and finish recording before switching projects";

let projectOpenInFlight = false;
export function _resetProjectOpenInFlightForTests(): void {
  projectOpenInFlight = false;
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
  if (!s.project?.tracks.some((t) => t.id === trackId)) {
    return { status: "disabled", reason: "Unknown track" };
  }
  const previous = s.project;
  const seqAtStart = currentDocumentSeq();
  s.setProject(patchTracksOrder(previous, trackId, index));
  try {
    const { reorderTrackCommand } = await import("../api");
    await reorderTrackCommand(s.projectPath, trackId, index);
    useDawStore.getState().announceStatus("Reordered track");
    return { status: "ok" };
  } catch (e) {
    revertOptimisticIfUnchanged(previous, seqAtStart);
    const msg = errorMessage(e);
    useDawStore.getState().announceStatus(`Reorder failed: ${msg}`);
    return { status: "disabled", reason: msg };
  }
}
export function registerProjectMediaCommands(): void {
  registerCommand("project.new", () => {
    if (desktopCloseGuardArmed()) {
      useDawStore.getState().announceStatus(PROJECT_SWITCH_BLOCKED);
      return { status: "disabled", reason: PROJECT_SWITCH_BLOCKED };
    }
    void (async () => {
      try {
        const { closeEpisodeProject } = await import("../api");
        await closeEpisodeProject();
      } catch {
        /* ?home=1 still shows Home when the unpin fails */
      }
      window.location.assign(homeUrl(window.location.href));
    })();
    return { status: "ok" };
  });

  registerCommand("project.open", () => {
    if (desktopCloseGuardArmed()) {
      useDawStore.getState().announceStatus(PROJECT_SWITCH_BLOCKED);
      return { status: "disabled", reason: PROJECT_SWITCH_BLOCKED };
    }
    if (projectOpenInFlight) {
      return { status: "ok" };
    }
    projectOpenInFlight = true;
    void (async () => {
      try {
        const { openEpisodeProject, pickEpisodeProject } = await import(
          "../api"
        );
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
            path = window.prompt(
              picked.detail || "Path to episode.project.json",
            );
          } else if ("project_path" in picked) {
            path = picked.project_path;
          }
        } catch (err) {
          const reason = errorMessage(err);
          useDawStore.getState().announceStatus(`Open failed: ${reason}`);
          return;
        }
        if (!path?.trim()) {
          return;
        }
        if (desktopCloseGuardArmed()) {
          useDawStore.getState().announceStatus(PROJECT_SWITCH_BLOCKED);
          return;
        }
        try {
          const out = await openEpisodeProject(path.trim());
          if (desktopCloseGuardArmed()) {
            useDawStore.getState().announceStatus(PROJECT_SWITCH_BLOCKED);
            return;
          }
          window.location.assign(
            projectUrl(window.location.href, out.project_path),
          );
        } catch (err) {
          const reason = errorMessage(err);
          useDawStore.getState().announceStatus(`Open failed: ${reason}`);
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
    const { addTrackCommand } = await import("../api");
    await addTrackCommand(s.projectPath, {});
    return { status: "ok" };
  });

  registerCommand("track.remove", async (args) => {
    return enqueueTrackMutate(async () => {
      const s = useDawStore.getState();
      if (!canIngestMedia(s.projectPath, s.guestMode, s.shareCapabilities)) {
        return { status: "disabled", reason: "Media ingest not allowed" };
      }
      const trackId = resolveInspectorTrackId(args);
      if (!trackId) {
        return { status: "disabled", reason: "No track selected in inspector" };
      }
      const track = s.project?.tracks.find((t) => t.id === trackId);
      const label = track?.label || trackId;
      if (!window.confirm(`Remove track ${label}?`)) {
        return { status: "disabled", reason: "Cancelled" };
      }
      try {
        const { removeTrackCommand } = await import("../api");
        await removeTrackCommand(s.projectPath, trackId);
        useDawStore.getState().announceStatus(`Removed ${label}`);
        const next = useDawStore.getState();
        next.setSelectedTrackIds(
          next.selectedTrackIds.filter((id) => id !== trackId),
        );
        next.setSelection(null);
        return { status: "ok" };
      } catch (e) {
        const msg = errorMessage(e);
        useDawStore.getState().announceStatus(`Remove failed: ${msg}`);
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
        : (s.selectedTrackIds[0] ??
          (s.selection?.kind === "track" ? s.selection.trackId : null));
    await ingestFiles(
      files,
      trackId ? { kind: "track", id: trackId } : { kind: "new" },
    );
    return { status: "ok" };
  });
}
