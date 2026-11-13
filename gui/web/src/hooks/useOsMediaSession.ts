import { useEffect } from "react";
import { livePlayheadSec } from "../audio/livePlayhead";
import {
  applyOsMediaSession,
  OS_SESSION_OFF,
  type OsMediaSessionState,
  type OsTransportCommands,
  osActionHandlers,
  osDiscontinuityKey,
  osTransportInput,
  projectOsMediaSession,
  sameOsInputs,
} from "../audio/osMediaSession";
import { episodeDurationSec } from "../audio/proxyMath";
import { skipListen } from "../commands/listenSeek";
import { runPointerCommand } from "../commands/pointer";
import { seekTransport } from "../commands/seek";
import { useDawStore } from "../state/dawStore";
import { syncPlayhead } from "../state/systemPlayhead";

const storeCommands: OsTransportCommands = {
  isPlaying: () => useDawStore.getState().isPlaying,
  livePositionSec: livePlayheadSec,
  previewActive: () => useDawStore.getState().sourcePreview !== null,
  previewPlaying: () => useDawStore.getState().sourcePreview?.playing === true,
  stopPreview: () => useDawStore.getState().setIsPlaying(false),
  resumeEpisode: () => useDawStore.getState().setIsPlaying(true),
  syncPlayhead,
  togglePlay: () => runPointerCommand("transport.togglePlay"),
  skip: (deltaSec) =>
    skipListen(deltaSec, episodeDurationSec(useDawStore.getState().project)),
  seek: (sec) => void seekTransport(sec),
};

/**
 * The one owner of the OS media surface (lock screen, notification, headphone
 * buttons) on a guest share link. It projects the transport store and re-applies
 * only when the store jumps (play, pause, seek, rate), never per frame: the OS
 * advances the position itself from the declared rate.
 */
export function useOsMediaSession(): void {
  useEffect(() => {
    if (
      typeof navigator === "undefined" ||
      !("mediaSession" in navigator) ||
      typeof MediaMetadata === "undefined"
    )
      return;
    const session = navigator.mediaSession;
    const handlers = osActionHandlers(storeCommands);
    const makeMetadata = (metadata: { title: string }) =>
      new MediaMetadata(metadata);
    let applied: OsMediaSessionState = OS_SESSION_OFF;
    let appliedKey = "";
    let startedPath: string | null = null;
    let seen: ReturnType<typeof useDawStore.getState> | null = null;
    let reported = false;
    const write = (next: OsMediaSessionState) => {
      try {
        applyOsMediaSession(session, next, applied, handlers, makeMetadata);
      } catch (error) {
        if (!reported && typeof globalThis.reportError === "function")
          globalThis.reportError(error);
        reported = true;
      }
      applied = next;
    };
    const sync = (state: ReturnType<typeof useDawStore.getState>) => {
      if (seen && sameOsInputs(seen, state)) return;
      seen = state;
      if (state.isPlaying || state.sourcePreview?.playing)
        startedPath = state.projectPath;
      const key = osDiscontinuityKey(state);
      if (key === appliedKey) return;
      appliedKey = key;
      const position = livePlayheadSec();
      const next = projectOsMediaSession(
        osTransportInput(state, position, startedPath === state.projectPath),
      );
      write(next);
    };
    sync(useDawStore.getState());
    const unsubscribe = useDawStore.subscribe(sync);
    return () => {
      unsubscribe();
      write(OS_SESSION_OFF);
    };
  }, []);
}
