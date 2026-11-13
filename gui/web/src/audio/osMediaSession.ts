import { isShareProjectKey } from "../shareMode";
import { transportAvailability } from "../state/transportAvailability";
import type { DawState } from "../state/types";
import { SKIP_SEC } from "../utils/time";
import { episodeDurationSec } from "./proxyMath";

/** Actions the lock screen or notification may send that the guest Player handles. */
const OS_ACTIONS = [
  "play",
  "pause",
  "seekbackward",
  "seekforward",
  "seekto",
] as const;
/** Set to null: the listener gets second skips, never track buttons. */
const OS_CLEARED_ACTIONS = ["previoustrack", "nexttrack"] as const;
type OsAction = (typeof OS_ACTIONS)[number];

export type OsTransportInput = Readonly<{
  /** A guest share with something to play. */
  available: boolean;
  title: string | null;
  durationSec: number;
  isPlaying: boolean;
  preview: Readonly<{ playing: boolean }> | null;
  /** The audio clock while a transport plays, else the store playhead. */
  positionSec: number;
  playbackRate: number;
}>;

type OsPositionState = Readonly<{
  duration: number;
  playbackRate: number;
  position: number;
}>;

export type OsMediaSessionState = Readonly<{
  metadata: Readonly<{ title: string }> | null;
  playbackState: "none" | "paused" | "playing";
  /** null clears the browser's position state. */
  positionState: OsPositionState | null;
  handlersOn: boolean;
}>;

export const OS_SESSION_OFF: OsMediaSessionState = {
  metadata: null,
  playbackState: "none",
  positionState: null,
  handlersOn: false,
};

/** Pure. `setPositionState` throws on a bad duration, position or rate, so the output can never hold one. */
export function projectOsMediaSession(
  input: OsTransportInput,
): OsMediaSessionState {
  if (!input.available) return OS_SESSION_OFF;
  const metadata = { title: input.title ?? "" };
  if (input.preview) {
    return {
      metadata,
      playbackState: input.preview.playing ? "playing" : "paused",
      positionState: null,
      handlersOn: true,
    };
  }
  const playbackState = input.isPlaying ? "playing" : "paused";
  const { durationSec, playbackRate } = input;
  // The engine starts over when asked to play from the end.
  const positionSec =
    input.isPlaying && input.positionSec >= durationSec ? 0 : input.positionSec;
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    return { metadata, playbackState, positionState: null, handlersOn: true };
  }
  return {
    metadata,
    playbackState,
    positionState: {
      duration: durationSec,
      playbackRate:
        Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1,
      position: Number.isFinite(positionSec)
        ? Math.min(durationSec, Math.max(0, positionSec))
        : 0,
    },
    handlersOn: true,
  };
}

const guestCanPlay = (state: DawState): boolean =>
  isShareProjectKey(state.projectPath) &&
  transportAvailability(state).togglePlay === undefined;

export function osTransportInput(
  state: DawState,
  positionSec: number,
  started: boolean,
): OsTransportInput {
  return {
    available: started && guestCanPlay(state),
    title: state.project?.meta.name ?? null,
    durationSec: episodeDurationSec(state.project),
    isPlaying: state.isPlaying,
    preview: state.sourcePreview
      ? { playing: state.sourcePreview.playing }
      : null,
    positionSec,
    playbackRate: state.playbackRate,
  };
}

/** True when no store field the change key reads has been replaced, so the key need not be built. */
export function sameOsInputs(a: DawState, b: DawState): boolean {
  return (
    a.projectPath === b.projectPath &&
    a.project === b.project &&
    a.isPlaying === b.isPlaying &&
    a.sourcePreview === b.sourcePreview &&
    a.playheadSeekRevision === b.playheadSeekRevision &&
    a.playbackRate === b.playbackRate
  );
}

/**
 * What the OS extrapolates from changes exactly when this key does: every
 * projection input but the position, plus the seek revision. The 60 Hz
 * playhead writes are not among them: the OS advances the position itself from
 * the declared rate.
 */
export function osDiscontinuityKey(state: DawState): string {
  return JSON.stringify([
    state.projectPath,
    state.playheadSeekRevision,
    { ...osTransportInput(state, 0, true), positionSec: 0 },
  ]);
}

export type MediaSessionLike = Pick<
  MediaSession,
  "metadata" | "playbackState" | "setActionHandler" | "setPositionState"
>;

type OsActionHandlers = Readonly<Record<OsAction, MediaSessionActionHandler>>;

/**
 * Writes the change from `prev` to `next`: metadata, then state, then position.
 * Blink recomputes the extrapolation rate when the state is set, so the fresh
 * position goes last. The position is written on every call that has one, not
 * only on a difference: WebKit extrapolates from the time of the last write, so
 * a resume at an unchanged position would otherwise jump ahead by the whole pause.
 */
export function applyOsMediaSession(
  session: MediaSessionLike,
  next: OsMediaSessionState,
  prev: OsMediaSessionState,
  handlers: OsActionHandlers,
  makeMetadata: (metadata: { title: string }) => MediaMetadata,
): void {
  if (prev.metadata?.title !== next.metadata?.title) {
    session.metadata = next.metadata ? makeMetadata(next.metadata) : null;
  }
  if (prev.handlersOn !== next.handlersOn) {
    for (const action of OS_ACTIONS)
      setHandler(session, action, next.handlersOn ? handlers[action] : null);
    if (next.handlersOn)
      for (const action of OS_CLEARED_ACTIONS)
        setHandler(session, action, null);
  }
  if (prev.playbackState !== next.playbackState) {
    session.playbackState = next.playbackState;
  }
  if (next.positionState) session.setPositionState(next.positionState);
  else if (prev.positionState) session.setPositionState();
}

function setHandler(
  session: MediaSessionLike,
  action: MediaSessionAction,
  handler: MediaSessionActionHandler | null,
): void {
  try {
    session.setActionHandler(action, handler);
  } catch {
    // A browser throws a TypeError for an action it does not support.
  }
}

/** Store-backed commands: the only way an OS action touches the transport. */
export type OsTransportCommands = Readonly<{
  isPlaying(): boolean;
  livePositionSec(): number;
  /** A source preview holds the transport, playing or ended. */
  previewActive(): boolean;
  /** The held source preview is audible. */
  previewPlaying(): boolean;
  stopPreview(): void;
  /** Releases any source preview and plays the episode as the Player's Play does. */
  resumeEpisode(): void;
  syncPlayhead(sec: number): void;
  togglePlay(): void;
  skip(deltaSec: number): void;
  seek(sec: number): void;
}>;

export function osActionHandlers(cmd: OsTransportCommands): OsActionHandlers {
  const skipBy = (direction: 1 | -1): MediaSessionActionHandler => {
    return (details) => {
      const offset = details.seekOffset;
      const usable = offset != null && Number.isFinite(offset) && offset > 0;
      cmd.skip(direction * (usable ? offset : SKIP_SEC));
    };
  };
  return {
    play: () => {
      // The OS shows Pause while a preview plays: a stray Play leaves it be.
      if (cmd.previewPlaying()) return;
      // An ended preview still holds the transport; `isPlaying` says nothing
      // audible then, so resume the episode instead of testing it.
      if (cmd.previewActive()) cmd.resumeEpisode();
      else if (!cmd.isPlaying()) cmd.togglePlay();
    },
    pause: () => {
      if (cmd.previewActive()) {
        cmd.stopPreview();
        return;
      }
      if (!cmd.isPlaying()) return;
      // A locked page paints no frames, so the store playhead is stale; the
      // pause effect would seek the paused engine back to it.
      cmd.syncPlayhead(cmd.livePositionSec());
      cmd.togglePlay();
    },
    seekbackward: skipBy(-1),
    seekforward: skipBy(1),
    seekto: (details) => {
      if (details.seekTime != null && Number.isFinite(details.seekTime))
        cmd.seek(details.seekTime);
    },
  };
}
