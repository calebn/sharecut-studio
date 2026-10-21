import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { loadProxyManifest } from "../api";
import { cachedFetchArrayBuffer } from "../audio/chunkCache";
import { bindPlaybackClock } from "../audio/playbackClock";
import { bindPlaybackMeterSource } from "../audio/playbackMeterSource";
import { ProxyEngine } from "../audio/proxyEngine";
import {
  chunkRefKey,
  type ImmutableChunkRef,
  isQueuedMoveOverlay,
  type ProxyManifest,
  parseProxyManifest,
  projectProxyBasis,
  proxyBasisKey,
} from "../audio/proxyMath";
import { recoverDocument } from "../document/applyDocumentUpdate";
import { isShareProjectKey, shareTokenFromKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import {
  loadCommandQueue,
  loadOfflineSnapshot,
  mergeOfflineSnapshot,
} from "../state/offlineStore";
import { useDaw } from "../state/useDaw";
import { ApiError, errorMessage } from "../utils/apiError";
import { audioContextCtor } from "../utils/audio";
import { AUDITION_STOP_EPS_SEC } from "../utils/auditionStop";
import { sortedVolumePoints } from "../utils/envelopes";

/**
 * Guest proxy transport: Web Audio clip scheduler over FX source-clock chunks.
 * Returns true while the proxy owns timeline playback. Owned source previews
 * yield playback to HTMLAudio without discarding the ready proxy engine.
 */
export function useProxyTransport(): boolean {
  const {
    project,
    projectPath,
    projectEpoch,
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
    projectEpoch: s.projectEpoch,
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

  const basis = useMemo(
    () => (project ? projectProxyBasis(project) : null),
    [project],
  );
  const basisKey = basis ? proxyBasisKey(basis) : "";
  const [accepted, setAccepted] = useState<{
    path: string;
    epoch: number;
    key: string;
    manifest: ProxyManifest;
  } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const engineRef = useRef<ProxyEngine | null>(null);
  const requestGeneration = useRef(0);
  const recoveredRefs = useRef(new Set<string>());
  const pendingManifest = useRef<ProxyManifest | null>(null);
  const acceptedKeyRef = useRef<string | null>(null);
  const ownedErrorRef = useRef<string | null>(null);
  const rafRef = useRef<number | null>(null);
  const appliedSeekRevision = useRef(playheadSeekRevision);
  const playheadSecRef = useRef(playheadSec);
  useEffect(() => {
    playheadSecRef.current = playheadSec;
  }, [playheadSec]);
  const playUntilRef = useRef(playUntilSec);
  useEffect(() => {
    playUntilRef.current = playUntilSec;
  }, [playUntilSec]);
  const ownsTimeline =
    !!projectPath && isShareProjectKey(projectPath) && sourcePreview === null;
  const active =
    accepted !== null &&
    accepted.path === projectPath &&
    accepted.epoch === projectEpoch &&
    accepted.key === basisKey;
  const timelineActive = active && sourcePreview === null;

  const block = useEffectEvent((error: unknown): void => {
    const state = useDawStore.getState();
    const engine = engineRef.current;
    if (
      engine &&
      acceptedKeyRef.current !== null &&
      state.isPlaying &&
      !state.sourcePreview
    )
      state.setPlayheadSec(engine.pause(), "playback");
    else engine?.pause();
    if (!state.sourcePreview) state.setIsPlaying(false);
    const message = errorMessage(
      error,
      "Audio is waiting for a matching project snapshot.",
    );
    ownedErrorRef.current = message;
    state.setAudioError(message);
    acceptedKeyRef.current = null;
    setAccepted(null);
  });

  const handleFailure = useEffectEvent(
    (error: unknown, ref: ImmutableChunkRef | null) => {
      const state = useDawStore.getState();
      if (
        state.projectPath !== projectPath ||
        state.projectEpoch !== projectEpoch
      )
        return;
      block(error);
      if (
        ref &&
        error instanceof ApiError &&
        error.code === "proxy_generation_unavailable"
      ) {
        const key = chunkRefKey(ref);
        if (recoveredRefs.current.has(key)) return;
        recoveredRefs.current.add(key);
        pendingManifest.current = null;
        setRefresh((value) => value + 1);
      }
    },
  );

  // A blocked proxy (a failed chunk fetch, a missing manifest) leaves nothing to retry it,
  // so a second Play would show Pause over a frozen playhead. Each Play after a block asks
  // for a fresh acceptance; if that fails again, block() stops playback with the error.
  const retryBlockedProxy = useEffectEvent((): void => {
    if (!ownsTimeline || active || ownedErrorRef.current === null) return;
    if (!engineRef.current) {
      useDawStore.getState().setIsPlaying(false);
      return;
    }
    setRefresh((value) => value + 1);
  });
  useEffect(() => {
    if (isPlaying) retryBlockedProxy();
  }, [isPlaying]);

  useLayoutEffect(() => {
    if (
      accepted &&
      accepted.path === projectPath &&
      accepted.epoch === projectEpoch &&
      accepted.key !== basisKey
    )
      block(new Error("Audio is waiting for a matching project snapshot."));
  }, [accepted, projectPath, projectEpoch, basisKey]);

  useEffect(() => {
    if (!projectPath || !isShareProjectKey(projectPath)) return;
    let disposed = false;
    acceptedKeyRef.current = null;
    recoveredRefs.current.clear();
    pendingManifest.current = null;
    try {
      const Ctx = audioContextCtor();
      if (!Ctx) throw new Error("Web Audio unavailable");
      engineRef.current = new ProxyEngine(
        new Ctx(),
        (ref) => cachedFetchArrayBuffer(projectPath, ref.url),
        (error, ref) => handleFailure(error, ref),
      );
    } catch (error) {
      queueMicrotask(() => {
        const state = useDawStore.getState();
        if (
          !disposed &&
          state.projectPath === projectPath &&
          state.projectEpoch === projectEpoch
        )
          block(error);
      });
    }
    return () => {
      disposed = true;
      requestGeneration.current += 1;
      engineRef.current?.dispose();
      engineRef.current = null;
      pendingManifest.current = null;
    };
  }, [projectPath, projectEpoch]);

  useEffect(() => {
    const project = useDawStore.getState().project;
    if (!projectPath || !isShareProjectKey(projectPath) || !project) return;
    const basis = projectProxyBasis(project);
    const generation = ++requestGeneration.current;
    const current = () => {
      const state = useDawStore.getState();
      return (
        generation === requestGeneration.current &&
        state.projectPath === projectPath &&
        state.projectEpoch === projectEpoch &&
        state.project !== null &&
        proxyBasisKey(projectProxyBasis(state.project)) === basisKey
      );
    };
    void (async () => {
      try {
        if (!engineRef.current) return;
        let cachedFallback = false;
        let manifest = pendingManifest.current;
        if (!manifest || proxyBasisKey(manifest.project_basis) !== basisKey) {
          try {
            const raw = await loadProxyManifest(projectPath);
            if (!current()) return;
            if (raw === null) throw new Error("Audio proxy is unavailable.");
            manifest = parseProxyManifest(raw);
          } catch (error) {
            if (!current()) return;
            const token = shareTokenFromKey(projectPath);
            const snapshot = token ? await loadOfflineSnapshot(token) : null;
            if (!current()) return;
            if (!snapshot?.manifest) throw error;
            manifest = parseProxyManifest(snapshot.manifest);
            cachedFallback = true;
          }
        }
        if (!current()) return;
        let matched = proxyBasisKey(manifest.project_basis) === basisKey;
        if (!matched && cachedFallback && navigator.onLine === false) {
          const token = shareTokenFromKey(projectPath);
          const queue = token ? await loadCommandQueue(token) : [];
          if (!current()) return;
          matched =
            navigator.onLine === false &&
            isQueuedMoveOverlay(
              manifest,
              basis,
              queue,
              project.tracks.map((track) => track.id),
            );
        }
        if (!matched && !cachedFallback) {
          pendingManifest.current = manifest;
          await recoverDocument();
          if (!current()) return;
        }
        if (!matched)
          throw new Error("Audio is waiting for a matching project snapshot.");
        if (!current()) return;
        const displayed = useDawStore.getState().project;
        if (!displayed) return;
        const outputIds = new Set(displayed.tracks.map((track) => track.id));
        if (
          Object.values(manifest.occurrences).some(
            (binding) => !outputIds.has(binding.outputTrackId),
          )
        )
          throw new Error("Invalid proxy output track.");
        pendingManifest.current = null;
        acceptedKeyRef.current = basisKey;
        setAccepted({
          path: projectPath,
          epoch: projectEpoch,
          key: basisKey,
          manifest,
        });
        const state = useDawStore.getState();
        if (state.audioError === ownedErrorRef.current)
          state.setAudioError(null);
        ownedErrorRef.current = null;
        const token = shareTokenFromKey(projectPath);
        if (token && !cachedFallback)
          void mergeOfflineSnapshot(token, {
            project: displayed,
            manifest,
          }).catch(() => undefined);
      } catch (error) {
        if (current()) block(error);
      }
    })();
    return () => {
      requestGeneration.current += 1;
    };
  }, [projectPath, projectEpoch, basisKey, refresh]);

  useEffect(() => {
    if (!active || !project || !accepted) return;
    engineRef.current?.setSnapshot({
      manifest: accepted.manifest,
      clipsByTrack: project.clips.tracks,
      tracks: project.tracks,
      volumeByTrack: Object.fromEntries(
        project.tracks.map((track) => [
          track.id,
          sortedVolumePoints(project.envelopes, track.id),
        ]),
      ),
    });
  }, [project, accepted, active]);

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

  return ownsTimeline;
}
