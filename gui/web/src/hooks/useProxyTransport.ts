import { useEffect, useRef, useState } from "react";
import { loadProxyManifest } from "../api";
import { cachedFetchArrayBuffer } from "../audio/chunkCache";
import { ProxyEngine } from "../audio/proxyEngine";
import type { ProxyManifest } from "../audio/proxyMath";
import { setActiveProxyEngine } from "../audio/proxyPeek";
import { isShareProjectKey, shareTokenFromKey } from "../shareMode";
import {
  loadOfflineSnapshot,
  mergeOfflineSnapshot,
} from "../state/offlineStore";
import { useDaw } from "../state/useDaw";
import {
  AUDITION_STOP_EPS_SEC,
  nextPlayheadAfterSkip,
} from "../utils/skipWindow";

/**
 * Guest proxy transport: Web Audio clip scheduler over FX source-clock chunks.
 * Returns true when the proxy path is active (caller should skip HTMLAudio).
 */
export function useProxyTransport(): boolean {
  const {
    project,
    projectPath,
    isPlaying,
    playheadSec,
    setPlayheadSec,
    playUntilSec,
    playSkipStartSec,
    playSkipEndSec,
    playAbFollowup,
    auditionEpoch,
    continueAudition,
    setIsPlaying,
    setAudioError,
    clearSessionRegion,
    viewerMute,
    soloTracks,
  } = useDaw();

  const [active, setActive] = useState(false);
  const engineRef = useRef<ProxyEngine | null>(null);
  const manifestRef = useRef<ProxyManifest | null>(null);
  const rafRef = useRef<number | null>(null);
  const abTimerRef = useRef<number | null>(null);
  const playheadSecRef = useRef(playheadSec);
  playheadSecRef.current = playheadSec;
  const playUntilRef = useRef(playUntilSec);
  playUntilRef.current = playUntilSec;
  const playSkipStartRef = useRef(playSkipStartSec);
  playSkipStartRef.current = playSkipStartSec;
  const playSkipEndRef = useRef(playSkipEndSec);
  playSkipEndRef.current = playSkipEndSec;
  const playAbFollowupRef = useRef(playAbFollowup);
  playAbFollowupRef.current = playAbFollowup;
  const auditionEpochRef = useRef(auditionEpoch);
  auditionEpochRef.current = auditionEpoch;

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
        const Ctx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext })
            .webkitAudioContext;
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
        setActiveProxyEngine(engine);
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
      setActiveProxyEngine(null);
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
    engineRef.current?.setSolo(soloTracks);
  }, [soloTracks, active]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !active) {
      return;
    }
    for (const t of project?.tracks ?? []) {
      engine.setTrackState(t.id, t.gain_db, viewerMute[t.id] ?? t.muted);
    }
  }, [project, viewerMute, active]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !active) {
      return;
    }
    let cancelled = false;
    if (isPlaying) {
      engine.play(playheadSecRef.current);
      const tick = () => {
        if (cancelled) {
          return;
        }
        let t = engine.currentTimeSec();
        const skipped = nextPlayheadAfterSkip(
          t,
          playSkipStartRef.current,
          playSkipEndRef.current,
        );
        if (skipped !== t) {
          t = skipped;
          engine.seek(t);
        }
        setPlayheadSec(t);
        const until = playUntilRef.current;
        if (until != null && t >= until - AUDITION_STOP_EPS_SEC) {
          const followup = playAbFollowupRef.current;
          if (followup) {
            playAbFollowupRef.current = null;
            engine.pause();
            continueAudition({
              playheadSec: followup.start,
              untilSec: followup.until,
              skip: { start: followup.skipStart, end: followup.skipEnd },
            });
            playSkipStartRef.current = followup.skipStart;
            playSkipEndRef.current = followup.skipEnd;
            playUntilRef.current = followup.until;
            const gen = auditionEpochRef.current;
            if (abTimerRef.current != null) {
              window.clearTimeout(abTimerRef.current);
            }
            abTimerRef.current = window.setTimeout(() => {
              abTimerRef.current = null;
              if (cancelled || auditionEpochRef.current !== gen) {
                return;
              }
              try {
                engine.play(followup.start);
              } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                setAudioError(msg);
                setIsPlaying(false);
                return;
              }
              setPlayheadSec(followup.start);
              rafRef.current = requestAnimationFrame(tick);
            }, Math.max(0, followup.gapSec) * 1000);
            return;
          }
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
      const t = engine.pause();
      setPlayheadSec(t);
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    }
    return () => {
      cancelled = true;
      if (abTimerRef.current != null) {
        window.clearTimeout(abTimerRef.current);
        abTimerRef.current = null;
      }
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [
    isPlaying,
    active,
    continueAudition,
    setIsPlaying,
    setPlayheadSec,
    setAudioError,
    clearSessionRegion,
  ]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || !active || isPlaying) {
      return;
    }
    engine.seek(playheadSec);
  }, [playheadSec, active, isPlaying]);

  return active;
}
