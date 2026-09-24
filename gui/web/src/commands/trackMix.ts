import { setTrackFaderCommand, setTrackMuteCommand } from "../api";
import { currentDocumentSeq } from "../document/cursor";
import { revertOptimisticIfUnchanged } from "../document/optimisticRevert";
import { patchTrackMix } from "../document/projectPatch";
import { canEditMix } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { clampFaderDb } from "../tracks/trackMix";
import type { TrackView } from "../types/project";
import { errorMessage } from "../utils/apiError";
import { registerCommand } from "./execute";
import { resolveTrackId } from "./targets";
import type { ExecuteResult } from "./types";

/** Splice the saved mix change locally, send it, and revert if it fails. */
async function commitTrackMix(
  trackId: string,
  fields: Partial<Pick<TrackView, "fader_db" | "muted">>,
  send: (projectPath: string) => Promise<unknown>,
): Promise<ExecuteResult> {
  const s = useDawStore.getState();
  const previous = s.project;
  const seqAtStart = currentDocumentSeq();
  if (previous) {
    s.setProject(patchTrackMix(previous, trackId, fields));
  }
  try {
    await send(s.projectPath);
    return { status: "ok" };
  } catch (e) {
    if (previous) {
      revertOptimisticIfUnchanged(previous, seqAtStart);
    }
    const reason = errorMessage(e);
    useDawStore.getState().announceStatus(`Mix change failed: ${reason}`);
    return { status: "disabled", reason };
  }
}

function mayEditMix(): boolean {
  const s = useDawStore.getState();
  return canEditMix(s.projectPath, s.guestMode, s.shareCapabilities);
}

/**
 * Track mix commands (#386). M is the saved mix mute for the host and editors
 * and a listen-only mute for everyone else; volume is saved and editor-only.
 * Solo (track.soloToggle) stays listen-only for everyone.
 */
export function registerTrackMixCommands(): void {
  registerCommand("track.muteToggle", async (args) => {
    const trackId = resolveTrackId(args);
    if (!trackId) {
      return { status: "disabled", reason: "No track selected" };
    }
    const s = useDawStore.getState();
    const track = s.project?.tracks.find((t) => t.id === trackId);
    if (!mayEditMix()) {
      if (track?.muted) {
        return {
          status: "disabled",
          reason: "Muted in the mix. Only the host and editors can unmute it",
        };
      }
      s.toggleViewerMute(trackId);
      return { status: "ok" };
    }
    if (!track) {
      return { status: "disabled", reason: "Unknown track" };
    }
    const muted = !track.muted;
    return commitTrackMix(trackId, { muted }, (projectPath) =>
      setTrackMuteCommand(projectPath, trackId, muted),
    );
  });

  registerCommand("track.setVolume", async (args) => {
    const trackId = resolveTrackId(args);
    if (!trackId) {
      return { status: "disabled", reason: "No track selected" };
    }
    if (typeof args.db !== "number" || !Number.isFinite(args.db)) {
      return { status: "disabled", reason: "Volume must be a number of dB" };
    }
    if (!mayEditMix()) {
      return {
        status: "disabled",
        reason: "Only the host and editors can change the mix",
      };
    }
    const faderDb = clampFaderDb(Math.round(args.db * 100) / 100);
    return commitTrackMix(trackId, { fader_db: faderDb }, (projectPath) =>
      setTrackFaderCommand(projectPath, trackId, faderDb),
    );
  });
}
