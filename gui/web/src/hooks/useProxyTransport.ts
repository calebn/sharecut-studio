import { useEffect, useRef, useState } from "react";
import { loadProxyManifest } from "../api";
import { cachedFetchArrayBuffer } from "../audio/chunkCache";
import { bindPlaybackClock } from "../audio/playbackClock";
import { bindPlaybackMeterSource } from "../audio/playbackMeterSource";
import { ProxyEngine } from "../audio/proxyEngine";
import type { ProxyManifest } from "../audio/proxyMath";
import { isShareProjectKey, shareTokenFromKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import {
  loadOfflineSnapshot,
  mergeOfflineSnapshot,
} from "../state/offlineStore";
import { useDaw } from "../state/useDaw";
import { audioContextCtor } from "../utils/audio";
import { AUDITION_STOP_EPS_SEC } from "../utils/auditionStop";

/**
 * Guest proxy transport: Web Audio clip scheduler over FX source-clock chunks.
 * Returns true while the proxy owns timeline playback. Owned source previews
 * yield playback to HTMLAudio without discarding the ready proxy engine.
 */
export function useProxyTransport(): boolean {
  const {
    project,
    projectPath,
    isPlaying,
    sourcePreview,
    playbackRate,
    playheadSec,
    playheadSeekRevision,
    setPlayheadSec,
    playUntilSec,
    setIsPlaying,
    clearSessionRegion,
    viewerMute,
    soloTracks,
  } = useDaw((s) => ({
    project: s.project,
    projectPath: s.projectPath,
    isPlaying: s.isPlaying,
    sourcePreview: s.sourcePreview,
    playbackRate: s.playbackRate,
    playheadSec: s.playheadSec,
    playheadSeekRevision: s.playheadSeekRevision,
    setPlayheadSec: s.setPlayheadSec,
    playUntilSec: s.playUntilSec,
    setIsPlaying: s.setIsPlaying,
    clearSessionRegion: s.clearSessionRegion,
    viewerMute: s.viewerMute,
    soloTracks: s.soloTracks,
  }));

  const [active, setActive] = useState(false);
  const timelineActive = active && sourcePreview === null;
  const engineRef = useRef<ProxyEngine | null>(null);
  const manifestRef = useRef<ProxyManifest | null>(null);
  const rafRef = useRef<number | null>(null);
  const appliedSeekRevision = useRef(playheadSeekRevision);
  const playheadSecRef = useRef(playheadSec);
  playheadSecRef.current = playheadSec;
  const playUntilRef = useRef(playUntilSec);
  playUntilRef.current = playUntilSec;

  useEffect(() => {
    if (!projectPath || !isShareProjectKey(projectPath)) {
      setActive(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        let manifest: ProxyManifest | null = null;
        try {
          manifest = await loadProxyManifest(projectPath);
        } catch {
          const token = shareTokenFromKey(projectPath);
          if (token) {
            const snap = await loadOfflineSnapshot(token);
            if (snap?.manifest) {
              manifest = snap.manifest as ProxyManifest;
            }
          }
        }
        if (cancelled) {
          return;
        }
        if (!manifest || Object.keys(manifest.tracks).length === 0) {
          setActive(false);
          return;
        }
        manifestRef.current = manifest;
        const Ctx = audioContextCtor();
        if (!Ctx) {
          throw new Error("Web Audio unavailable");
        }
        const ctx = new Ctx();
        const engine = new ProxyEngine(ctx, async (trackId, idx) => {
          const url = manifest!.tracks[trackId]?.urls[idx];
          if (!url) {
            throw new Error(`missing proxy url ${trackId}/${idx}`);
          }
          return cachedFetchArrayBuffer(url);
        });
        engine.setManifest(manifest);
        if (cancelled) {
          engine.dispose();
          return;
        }
        engineRef.current = engine;
        const token = shareTokenFromKey(projectPath);
        if (token) {
          void mergeOfflineSnapshot(token, { manifest });
        }
        setActive(true);
      } catch {
        if (!cancelled) {
          setActive(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      engineRef.current?.dispose();
      engineRef.current = null;
      setActive(false);
    };
  }, [projectPath]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !project || !active) {
      return;
    }
    engine.setProject(project.clips.tracks, project.tracks);
  }, [project, active]);

  useEffect(() => {
    engineRef.current?.setPlaybackRate(playbackRate);
  }, [playbackRate, active]);

  useEffect(() => {
    engineRef.current?.setSolo(soloTracks);
  }, [soloTracks, active]);

  useEffect(() => {
    engineRef.current?.setListenMute(viewerMute);
  }, [viewerMute, active]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !active) {
      return;
    }
    if (!timelineActive) {
      engine.pause();
      return;
    }
    let cancelled = false;
    if (isPlaying) {
      engine.play(playheadSecRef.current);
      const tick = () => {
        const state = useDawStore.getState();
        if (cancelled || !state.isPlaying || state.sourcePreview) {
          return;
        }
        const t = engine.currentTimeSec();
        setPlayheadSec(t, "playback");
        const until = playUntilRef.current;
        if (until != null && t >= until - AUDITION_STOP_EPS_SEC) {
          engine.pause();
          setPlayheadSec(until);
          setIsPlaying(false);
          clearSessionRegion();
          return;
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } else {
      // Keep the store playhead (Stop may have rewound it); the seek effect
      // below moves the paused engine there.
      engine.pause();
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    }
    return () => {
      cancelled = true;
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [
    isPlaying,
    active,
    timelineActive,
    setIsPlaying,
    setPlayheadSec,
    clearSessionRegion,
  ]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !active) {
      return;
    }
    if (!isPlaying || appliedSeekRevision.current !== playheadSeekRevision) {
      engine.seek(playheadSec);
      appliedSeekRevision.current = playheadSeekRevision;
    }
  }, [playheadSec, playheadSeekRevision, active, isPlaying]);

  useEffect(() => {
    if (!timelineActive) return;
    return bindPlaybackClock(() =>
      useDawStore.getState().projectPath === projectPath &&
      !useDawStore.getState().sourcePreview &&
      useDawStore.getState().isPlaying &&
      rafRef.current != null
        ? (engineRef.current?.currentTimeSec() ?? null)
        : null,
    );
  }, [timelineActive, projectPath]);

  useEffect(() => {
    if (!timelineActive) return;
    return bindPlaybackMeterSource({
      read: (trackId) =>
        useDawStore.getState().sourcePreview
          ? null
          : (engineRef.current?.readTrackFrame(trackId) ?? null),
    });
  }, [timelineActive]);

  return timelineActive;
}
