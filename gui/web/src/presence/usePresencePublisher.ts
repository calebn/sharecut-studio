import { useEffect, useRef } from "react";
import { playbackPositionSec } from "../audio/playbackClock";
import { selectionToWire } from "../session/wire";
import { useDawStore } from "../state/dawStore";
import { mobileModeForStage, tabForStage } from "../state/stageRoutes";
import { timelineViewportRegistry } from "../state/timelineViewportRegistry";
import type { DawStore } from "../state/types";
import type { PresenceCursor } from "../types/session";
import { timelineTimeViewportWidth } from "../utils/timelineViewport";
import { setPresenceCursorSink, zoomScrollToViewport } from "./followSync";
import { createPresenceThrottle, type PresenceSend } from "./publisher";

type PresenceThrottle = ReturnType<typeof createPresenceThrottle>;

const KEEPALIVE_MS = 10_000;

/** Store fields the `ui` frame is built from. */
const UI_KEYS = [
  "stage",
  "reviewSection",
  "guestMode",
  "editSurface",
  "shellBreakpoint",
  "pointerKind",
  "auditionMode",
  "viewerMute",
  "soloTracks",
  "transcriptViewAnchor",
] as const satisfies readonly (keyof DawStore)[];

export function usePresencePublisher(
  send: PresenceSend | null,
  label: string,
): void {
  const throttleRef = useRef(createPresenceThrottle());
  const seqRef = useRef(1);
  const sendRef = useRef(send);
  sendRef.current = send;
  const labelRef = useRef(label);
  labelRef.current = label;

  useEffect(() => {
    const throttle = createPresenceThrottle();
    throttleRef.current = throttle;
    throttle.onSend((meta) => {
      const socketSend = sendRef.current;
      if (!socketSend) {
        return;
      }
      const s = useDawStore.getState();
      socketSend({
        type: "Presence",
        client_seq: seqRef.current++,
        ...(s.followingClientId
          ? {}
          : {
              playhead_sec:
                meta.transport?.playhead_sec ??
                (s.isPlaying
                  ? (playbackPositionSec() ?? s.playheadSec)
                  : s.playheadSec),
            }),
        label: labelRef.current,
        meta: {
          display_name: labelRef.current,
          ...meta,
        },
      });
    });
    return () => throttle.dispose();
  }, []);

  useEffect(() => {
    if (!send) {
      return;
    }
    setPresenceCursorSink((cursor: PresenceCursor | null) => {
      throttleRef.current.push({ cursor });
    });
    return () => setPresenceCursorSink(null);
  }, [send]);

  useEffect(() => {
    if (!send) {
      return;
    }
    const id = window.setInterval(() => {
      throttleRef.current.heartbeat();
    }, KEEPALIVE_MS);
    return () => window.clearInterval(id);
  }, [send]);

  // Published from store subscriptions, not selectors: the host's app root
  // calls this hook, and a playhead or scroll tick must not re-render it.
  useEffect(() => {
    if (!send) {
      return;
    }
    const push = (
      meta: Parameters<PresenceThrottle["push"]>[0],
      immediate = false,
    ) => throttleRef.current.push(meta, immediate);
    const publishFollowing = (s: DawStore) => {
      if (s.followingClientId) {
        push({
          following: s.followingClientId,
          transport: null,
          viewport: null,
        });
        return;
      }
      push({ following: null });
    };
    const publishTransport = (s: DawStore, immediate = false, seek = false) => {
      if (s.followingClientId) {
        return;
      }
      push(
        {
          transport: {
            playing: s.isPlaying,
            playhead_sec:
              s.isPlaying && !seek
                ? (playbackPositionSec() ?? s.playheadSec)
                : s.playheadSec,
            rate: s.playbackRate,
          },
        },
        immediate,
      );
    };
    const publishSelection = (s: DawStore) => {
      push({ selection: selectionToWire(s.selection, s.project?.envelopes) });
    };
    const publishViewport = (s: DawStore) => {
      if (s.followingClientId) {
        return;
      }
      push({
        viewport: zoomScrollToViewport(
          s.scrollLeft,
          s.zoomPxPerSec,
          timelineTimeViewportWidth(
            timelineViewportRegistry.getTimelineElement(),
          ),
        ),
      });
    };
    const publishUi = (s: DawStore) => {
      push({
        ui: {
          // A guest sees Comments whatever the store holds.
          tab: tabForStage(s.stage, s.guestMode ? "comments" : s.reviewSection),
          mobile_mode:
            s.shellBreakpoint === "phone" || s.pointerKind === "coarse"
              ? mobileModeForStage(s.stage, s.editSurface)
              : null,
          transcript_anchor: s.stage === "edit" ? s.transcriptViewAnchor : null,
          audition: s.auditionMode,
          viewer_mute: Object.keys(s.viewerMute)
            .filter((k) => s.viewerMute[k])
            .sort(),
          solo: Object.keys(s.soloTracks)
            .filter((k) => s.soloTracks[k])
            .sort(),
        },
      });
    };

    // Connect: publish everything once, in the order of the frames below.
    const initial = useDawStore.getState();
    publishFollowing(initial);
    publishTransport(initial, true);
    publishSelection(initial);
    publishViewport(initial);
    publishUi(initial);

    const playbackTimer = window.setInterval(() => {
      const s = useDawStore.getState();
      if (s.isPlaying) publishTransport(s);
    }, 1000);
    const unsubscribe = useDawStore.subscribe((s, prev) => {
      const followChanged = s.followingClientId !== prev.followingClientId;
      if (followChanged) {
        publishFollowing(s);
      }
      if (
        followChanged ||
        s.playheadSeekRevision !== prev.playheadSeekRevision ||
        (!s.isPlaying && s.playheadSec !== prev.playheadSec) ||
        s.isPlaying !== prev.isPlaying ||
        s.playbackRate !== prev.playbackRate
      ) {
        publishTransport(
          s,
          true,
          s.playheadSeekRevision !== prev.playheadSeekRevision,
        );
      }
      if (s.selection !== prev.selection) {
        publishSelection(s);
      }
      if (
        followChanged ||
        s.scrollLeft !== prev.scrollLeft ||
        s.zoomPxPerSec !== prev.zoomPxPerSec
      ) {
        publishViewport(s);
      }
      if (UI_KEYS.some((key) => s[key] !== prev[key])) {
        publishUi(s);
      }
    });
    return () => {
      unsubscribe();
      window.clearInterval(playbackTimer);
    };
  }, [send]);
}
