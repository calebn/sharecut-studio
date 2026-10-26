import { useCallback, useMemo, useRef } from "react";
import { runPointerCommand } from "../../commands/pointer";
import { seekTransport } from "../../commands/seek";
import { rosterDisplayName } from "../../presence/colors";
import { rosterEntry } from "../../presence/roster";
import { guestHearsMixOnly } from "../../shareMode";
import { useDawStore } from "../../state/dawStore";
import { useDaw } from "../../state/useDaw";
import type { PlayerProps } from "../../system/Player";
import type { AuditionMode } from "../../types/session";
import { NO_PREVIEW_ERROR } from "../../utils/audioErrorLabel";
import { transportTimecode } from "../../utils/time";
import { skipListen } from "./listenSeek";
import {
  auditionOf,
  chapterIndexAt,
  cutsLabel,
  hearModeOf,
  playerChapters,
  playerTicks,
} from "./playerModel";

const NONE: never[] = [];

/**
 * The Player's props from the transport, project and presence state. The
 * playhead is read here, so the bar re-renders on each tick and nothing
 * around it does.
 */
export function usePlayerProps(
  form: PlayerProps["form"],
  onFormChange: (form: PlayerProps["form"]) => void,
): PlayerProps | null {
  const {
    project,
    isPlaying,
    audioError,
    auditionMode,
    renderPreviewBusy,
    guestMode,
    followingClientId,
    sessionClients,
  } = useDaw((s) => ({
    project: s.project,
    isPlaying: s.isPlaying,
    audioError: s.audioError,
    auditionMode: s.auditionMode,
    renderPreviewBusy: s.renderPreviewBusy,
    guestMode: s.guestMode,
    followingClientId: s.followingClientId,
    sessionClients: s.sessionClients,
  }));
  const playheadSec = useDawStore((s) => s.playheadSec);
  // What was playing when A was pressed, so letting go goes back to it.
  const beforeOriginal = useRef<AuditionMode>("mix");

  const setAudition = useCallback((mode: AuditionMode) => {
    runPointerCommand("transport.audition", { mode });
  }, []);
  const onHearOriginal = useCallback(
    (on: boolean) => {
      const current = useDawStore.getState().auditionMode;
      if (on) {
        if (current !== "raw") beforeOriginal.current = current;
        setAudition("raw");
      } else {
        setAudition(current === "raw" ? beforeOriginal.current : current);
      }
    },
    [setAudition],
  );

  const duration = project?.timeline_duration_sec ?? 0;
  const chapterMarkers = project?.chapters ?? NONE;
  const chapters = useMemo(
    () => playerChapters(chapterMarkers, duration),
    [chapterMarkers, duration],
  );
  const comments = project?.comments;
  const ticks = useMemo(
    () =>
      playerTicks(
        chapters,
        (comments ?? NONE).map((c) => c.timeline_start),
        duration,
      ),
    [chapters, comments, duration],
  );

  if (!project) return null;
  const clock = transportTimecode(playheadSec, duration);
  const guest = guestHearsMixOnly(guestMode);
  const leader = followingClientId
    ? rosterEntry(sessionClients, followingClientId)
    : undefined;
  const hasAudioError = audioError !== null && audioError !== NO_PREVIEW_ERROR;
  const state: PlayerProps["state"] = hasAudioError
    ? "error"
    : renderPreviewBusy
      ? "mix-updating"
      : "ready";

  return {
    form,
    playing: isPlaying,
    time: clock.current,
    total: clock.total,
    cuts: cutsLabel(project.edit_impact.total_removed_sec),
    state,
    hearOriginal: auditionMode === "raw",
    guest,
    following: followingClientId
      ? {
          name: leader ? rosterDisplayName(leader) : followingClientId,
          colorIndex: leader?.meta?.color_index ?? 0,
        }
      : undefined,
    title: project.meta.name,
    chapters,
    chapter: chapterIndexAt(chapterMarkers, playheadSec),
    ticks,
    playhead: duration > 0 ? playheadSec / duration : 0,
    hearMenu: guest
      ? undefined
      : {
          mode: hearModeOf(auditionMode),
          onMode: (mode) => setAudition(auditionOf(mode)),
        },
    onPlayPause: () => runPointerCommand("transport.togglePlay"),
    onSkip: (seconds) => skipListen(seconds, duration),
    onHearOriginal: guest ? undefined : onHearOriginal,
    onComment: () => {
      runPointerCommand("comment.draftAt", {
        atTime: useDawStore.getState().playheadSec,
      });
      useDawStore.getState().openStage("review", { section: "comments" });
    },
    onExpand: () => onFormChange("expanded"),
    onCollapse: () => onFormChange("bar"),
    onRetry: () => {
      useDawStore.getState().setAudioError(null);
      runPointerCommand("transport.togglePlay");
    },
    onChapter: (index) => {
      const target = [...chapterMarkers].sort((a, b) => a.time - b.time)[index];
      if (target) void seekTransport(target.time);
    },
    onUnfollow: () => runPointerCommand("presence.unfollow"),
  };
}
