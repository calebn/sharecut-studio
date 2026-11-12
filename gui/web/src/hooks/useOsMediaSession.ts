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
    const sync = (state: ReturnType<typeof useDawStore.getState>) => {
      const key = osDiscontinuityKey(state);
      if (key === appliedKey) return;
      appliedKey = key;
      const next = projectOsMediaSession(
        osTransportInput(state, livePlayheadSec()),
      );
      applyOsMediaSession(session, next, applied, handlers, makeMetadata);
      applied = next;
    };
    sync(useDawStore.getState());
    const unsubscribe = useDawStore.subscribe(sync);
    return () => {
      unsubscribe();
      applyOsMediaSession(
        session,
        OS_SESSION_OFF,
        applied,
        handlers,
        makeMetadata,
      );
    };
  }, []);
}
