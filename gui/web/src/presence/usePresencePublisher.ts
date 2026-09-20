import { useEffect, useRef } from "react";
import { selectionToWire } from "../session/wire";
import { useDawStore } from "../state/dawStore";
import type { PresenceCursor } from "../types/session";
import { timelineTimeViewportWidth } from "../utils/timelineViewport";
import { setPresenceCursorSink } from "./followSync";
import { createPresenceThrottle, type PresenceSend } from "./publisher";

const KEEPALIVE_MS = 10_000;

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
        ...(s.followingClientId ? {} : { playhead_sec: s.playheadSec }),
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

  const playheadSec = useDawStore((s) => s.playheadSec);
  const isPlaying = useDawStore((s) => s.isPlaying);
  const selection = useDawStore((s) => s.selection);
  const scrollLeft = useDawStore((s) => s.scrollLeft);
  const zoomPxPerSec = useDawStore((s) => s.zoomPxPerSec);
  const followingClientId = useDawStore((s) => s.followingClientId);
  const activeTab = useDawStore((s) => s.activeTab);
  const mobileMode = useDawStore((s) => s.mobileMode);
  const shellBreakpoint = useDawStore((s) => s.shellBreakpoint);
  const auditionMode = useDawStore((s) => s.auditionMode);
  const viewerMute = useDawStore((s) => s.viewerMute);
  const soloTracks = useDawStore((s) => s.soloTracks);
  const transcriptViewAnchor = useDawStore((s) => s.transcriptViewAnchor);

  useEffect(() => {
    if (!send) {
      return;
    }
    if (followingClientId) {
      throttleRef.current.push({
        following: followingClientId,
        transport: null,
        viewport: null,
      });
      return;
    }
    throttleRef.current.push({ following: null });
  }, [send, followingClientId]);

  useEffect(() => {
    if (!send || followingClientId) {
      return;
    }
    throttleRef.current.push({
      transport: {
        playing: isPlaying,
        playhead_sec: playheadSec,
        rate: useDawStore.getState().playbackRate,
      },
    });
  }, [send, playheadSec, isPlaying, followingClientId]);

  useEffect(() => {
    if (!send) {
      return;
    }
    throttleRef.current.push({
      selection: selectionToWire(
        selection,
        useDawStore.getState().project?.envelopes,
      ),
    });
  }, [send, selection]);

  useEffect(() => {
    if (!send || followingClientId) {
      return;
    }
    const el = useDawStore.getState()._timelineEl;
    const width = timelineTimeViewportWidth(el);
    const zoom = zoomPxPerSec > 0 ? zoomPxPerSec : 1;
    const start = scrollLeft / zoom;
    const span = width > 0 ? width / zoom : 60;
    throttleRef.current.push({
      viewport: { start_sec: start, end_sec: start + Math.max(span, 0.1) },
    });
  }, [send, scrollLeft, zoomPxPerSec, followingClientId]);

  useEffect(() => {
    if (!send) {
      return;
    }
    throttleRef.current.push({
      ui: {
        tab: activeTab,
        mobile_mode: shellBreakpoint === "phone" ? mobileMode : null,
        transcript_anchor:
          activeTab === "transcript" ? transcriptViewAnchor : null,
        audition: auditionMode,
        viewer_mute: Object.keys(viewerMute)
          .filter((k) => viewerMute[k])
          .sort(),
        solo: Object.keys(soloTracks)
          .filter((k) => soloTracks[k])
          .sort(),
      },
    });
  }, [
    send,
    activeTab,
    mobileMode,
    shellBreakpoint,
    auditionMode,
    viewerMute,
    soloTracks,
    transcriptViewAnchor,
  ]);
}
