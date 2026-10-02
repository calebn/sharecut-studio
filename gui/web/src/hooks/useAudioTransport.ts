import { useEffect, useRef } from "react";
import { audioUrl } from "../api";
import { createHostPlaybackMeterMonitor } from "../audio/hostPlaybackMeterMonitor";
import { bindPlaybackClock } from "../audio/playbackClock";
import { bindPlaybackMeterSource } from "../audio/playbackMeterSource";
import { isShareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { pickDaw, useDaw } from "../state/useDaw";
import type { ProjectView, TrackView } from "../types/project";
import { errorMessage } from "../utils/apiError";
import {
  anySolo,
  dbToLinear,
  trackIsAudible,
  trackOutputGainDb,
} from "../utils/audio";
import {
  projectHasSourceAudio,
  trackHasAudioContent,
} from "../utils/projectMedia";
import {
  AUDITION_STOP_EPS_SEC,
  nextPlayheadAfterSkip,
} from "../utils/skipWindow";
import {
  clipsForOriginTrack,
  sourcePointToTimeline,
  timelinePointToSource,
} from "../utils/timebase";

const selectAudioTransportFields = pickDaw(
  "project",
  "projectPath",
  "projectEpoch",
  "playheadSec",
  "playheadSeekRevision",
  "setPlayheadSec",
  "isPlaying",
  "sourcePreview",
  "updateSourcePreview",
  "setIsPlaying",
  "auditionMode",
  "viewerMute",
  "soloTracks",
  "playUntilSec",
  "setPlayUntilSec",
  "playSkipStartSec",
  "playSkipEndSec",
  "playAbFollowup",
  "auditionEpoch",
  "continueAudition",
  "clearSessionRegion",
  "setAudioError",
  "playbackRate",
);

function rawSourceSec(
  project: ProjectView,
  trackId: string,
  timelineSec: number,
): number | null {
  const clips = clipsForOriginTrack(project.clips.tracks, trackId);
  if (clips.length === 0) {
    return timelineSec;
  }
  return timelinePointToSource(clips, timelineSec);
}

function seekElement(el: HTMLAudioElement, mediaSec: number): void {
  el.currentTime = Math.min(Math.max(0, mediaSec), el.duration || mediaSec);
}

function seekPlayersToTimeline(
  players: Map<string, HTMLAudioElement>,
  project: ProjectView,
  timelineSec: number,
  auditionMode: string,
  threshold: number,
): void {
  if (auditionMode !== "raw") {
    for (const el of players.values()) {
      if (Math.abs(el.currentTime - timelineSec) > threshold) {
        seekElement(el, timelineSec);
      }
    }
    return;
  }
  for (const [key, el] of players) {
    if (key === "premix") {
      continue;
    }
    const sourceSec = rawSourceSec(project, key, timelineSec);
    if (sourceSec == null) {
      continue;
    }
    if (Math.abs(el.currentTime - sourceSec) > threshold) {
      seekElement(el, sourceSec);
    }
  }
}

function masterTimelineSec(
  master: HTMLAudioElement,
  masterKey: string,
  project: ProjectView,
  auditionMode: string,
): number {
  if (auditionMode !== "raw" || masterKey === "premix") {
    return master.currentTime;
  }
  const clips = clipsForOriginTrack(project.clips.tracks, masterKey);
  if (clips.length === 0) {
    return master.currentTime;
  }
  return sourcePointToTimeline(clips, master.currentTime) ?? master.currentTime;
}

function pickMaster(
  players: Map<string, HTMLAudioElement>,
): [string, HTMLAudioElement] | null {
  const premix = players.get("premix");
  if (premix) {
    return ["premix", premix];
  }
  const first = [...players.entries()][0];
  return first ?? null;
}

/** Fingerprint effect bypass state so stem players remount after A/B toggles. */
function effectsFingerprint(project: ProjectView): string {
  const parts: string[] = [];
  for (const track of project.tracks) {
    const fx = project.effects_by_track[track.id] ?? [];
    const bits = fx.map((e) => `${e.effect}:${e.bypass ? 1 : 0}`).join(",");
    const fresh =
      track.stem_is_fresh === true
        ? "1"
        : track.stem_is_fresh === false
          ? "0"
          : "x";
    parts.push(`${track.id}:${fresh}:${bits}`);
  }
  return parts.join("|");
}

/** What a track's stem renders from now; changes with edits, not the mix. */
function stemRenderHash(project: ProjectView, trackId: string): string {
  return project.render_status.tracks?.[trackId]?.render_hash ?? "";
}

function trackPlaybackUrl(
  project: ProjectView,
  projectPath: string,
  track: TrackView,
  kind: "stem" | "raw",
): string {
  const trackId = track.id;
  if (kind === "raw") return audioUrl(projectPath, kind, trackId);
  const cacheKey = `${track.stem_is_fresh ? "f" : "s"}-${stemRenderHash(
    project,
    trackId,
  )}-${(project.effects_by_track[trackId] ?? [])
    .map((effect) => `${effect.effect}:${effect.bypass ? 1 : 0}`)
    .join(",")}`;
  return audioUrl(projectPath, kind, trackId, {
    rerender: track.stem_is_fresh === false,
    cacheKey,
  });
}

/**
 * What the players load. They're rebuilt only when this changes: a saved
 * volume or mute change patches the project too, and rebuilding the players
 * would stop playback. The volume effect applies gains and mutes.
 */
function playerSourcesKey(
  project: ProjectView,
  source: "premix" | "stem" | "raw",
): string {
  if (source === "premix") {
    const premix = project.render_status.premix;
    return `premix:${premix.exists ? (premix.mtime_sec ?? 1) : 0}`;
  }
  return project.tracks
    .map((track) => {
      const content =
        source === "stem" ? stemRenderHash(project, track.id) : "";
      return `${track.id}:${trackHasAudioContent(track, project) ? 1 : 0}:${track.media_path ?? ""}:${content}`;
    })
    .join(",");
}

/**
 * Browser transport: HTMLAudioElement + HTTP Range.
 * - mix (no listen-only mute/solo, premix current): premix.wav
 * - mix with listen-only mute/solo or a premix stale vs the saved mix
 *   (volume, mute), or fx: processed stems at their output gain
 * - raw: source media files at their output gain (seek via clip timeline→source)
 */
export function useAudioTransport(enabled = true): void {
  const {
    project,
    projectPath,
    projectEpoch,
    playheadSec,
    playheadSeekRevision,
    setPlayheadSec,
    isPlaying: timelineIsPlaying,
    sourcePreview: preview,
    updateSourcePreview,
    setIsPlaying,
    auditionMode,
    viewerMute,
    soloTracks,
    playUntilSec,
    setPlayUntilSec,
    playSkipStartSec,
    playSkipEndSec,
    playAbFollowup,
    auditionEpoch,
    continueAudition,
    clearSessionRegion,
    setAudioError,
    playbackRate,
  } = useDaw(selectAudioTransportFields);

  const isPlaying = preview ? preview.playing : timelineIsPlaying;
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const previewUrl = preview
    ? preview.media.kind === "rendered"
      ? preview.media.url
      : audioUrl(projectPath, "raw", preview.media.trackId, {
          ...(preview.media.sourceId !== null
            ? { sourceId: preview.media.sourceId }
            : {}),
          cacheKey: preview.media.cacheKey,
        })
    : null;
  const previewUrlRef = useRef(previewUrl);
  previewUrlRef.current = previewUrl;
  const playersRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const rafRef = useRef<number | null>(null);
  const meterMonitorRef = useRef<ReturnType<
    typeof createHostPlaybackMeterMonitor
  > | null>(null);
  const abTimerRef = useRef<number | null>(null);
  const playheadRef = useRef(playheadSec);
  const appliedSeekRevision = useRef(playheadSeekRevision);
  const drivingPlayheadRef = useRef(false);
  const projectRef = useRef(project);
  const auditionModeRef = useRef(auditionMode);

  playheadRef.current = playheadSec;
  projectRef.current = project;
  auditionModeRef.current = auditionMode;

  // A premix mixed before a volume or mute change would play the old mix;
  // stems at their current output gain play the new one before a refresh.
  const premixStaleVsMix = project?.render_status.premix.stale_vs_mix === true;
  const needsMultitrack =
    auditionMode !== "mix" ||
    premixStaleVsMix ||
    anySolo(soloTracks) ||
    Object.values(viewerMute).some(Boolean);

  const fxKey = project ? effectsFingerprint(project) : "";
  const playerSource =
    auditionMode === "raw"
      ? "raw"
      : !needsMultitrack && auditionMode === "mix"
        ? "premix"
        : "stem";
  const sourcesKey = project ? playerSourcesKey(project, playerSource) : "";
  const modeKey = previewUrl
    ? `source-preview:${previewUrl}`
    : `${auditionMode}:${needsMultitrack ? "mt" : "premix"}:${fxKey}:${sourcesKey}`;

  useEffect(() => {
    if (!enabled) {
      const players = playersRef.current;
      for (const el of players.values()) {
        el.pause();
        el.removeAttribute("src");
        el.load();
      }
      players.clear();
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      return;
    }
    const project = projectRef.current;
    if (!project) {
      return;
    }
    const players = playersRef.current;
    for (const el of players.values()) {
      el.pause();
      el.removeAttribute("src");
      el.load();
    }
    players.clear();
    setAudioError(null);
    const playerEvents = new AbortController();

    const make = (key: string, url: string) => {
      const el = new Audio();
      el.preload = "metadata";
      el.src = url;
      el.addEventListener(
        "error",
        () => {
          if (useDawStore.getState().projectEpoch !== projectEpoch) {
            return;
          }
          const source = previewRef.current;
          if (key === "source-preview") {
            if (!source || previewUrlRef.current !== url) return;
            updateSourcePreview(
              source.ownerId,
              source.generation,
              source.startSec,
              true,
              {
                kind: "unavailable",
                message: "The recording could not be loaded.",
              },
            );
          } else {
            if (source) return;
            setAudioError(`Failed to load audio (${key})`);
            setIsPlaying(false);
          }
        },
        { signal: playerEvents.signal },
      );
      players.set(key, el);
      el.playbackRate = useDawStore.getState().playbackRate;
    };

    if (previewUrlRef.current) {
      make("source-preview", previewUrlRef.current);
    } else if (!needsMultitrack && auditionMode === "mix") {
      if (!project.render_status.premix.exists) {
        // Tracks without source media have nothing to play. The absent premix
        // is expected until audio exists (#78).
        if (projectHasSourceAudio(project)) {
          setAudioError("No premix. Run Pipeline or render-preview");
        }
        return;
      }
      make("premix", audioUrl(projectPath, "premix"));
    } else {
      const kind: "stem" | "raw" = auditionMode === "raw" ? "raw" : "stem";
      for (const track of project.tracks) {
        if (!trackHasAudioContent(track, project)) {
          continue;
        }
        make(track.id, trackPlaybackUrl(project, projectPath, track, kind));
      }
    }

    const t = previewRef.current?.startSec ?? playheadRef.current;
    for (const [key, el] of players) {
      const mediaSec =
        !previewRef.current && auditionMode === "raw" && key !== "premix"
          ? (rawSourceSec(project, key, t) ?? t)
          : t;
      const apply = () => {
        seekElement(el, mediaSec);
      };
      if (el.readyState >= 1) {
        apply();
      } else {
        el.addEventListener("loadedmetadata", apply, { once: true });
      }
    }

    return () => {
      playerEvents.abort();
      for (const el of players.values()) {
        el.pause();
        el.removeAttribute("src");
        el.load();
      }
      players.clear();
    };
  }, [
    enabled,
    projectPath,
    projectEpoch,
    modeKey,
    needsMultitrack,
    auditionMode,
    setAudioError,
    setIsPlaying,
    updateSourcePreview,
  ]);

  useEffect(() => {
    if (!enabled || !project) {
      return;
    }
    const players = playersRef.current;
    const sourcePlayer = players.get("source-preview");
    if (sourcePlayer) {
      sourcePlayer.volume = 1;
      return;
    }
    const premix = players.get("premix");
    if (premix) {
      premix.volume = 1;
      return;
    }
    // Media elements can't boost (volume <= 1). Play each track at its output
    // gain (staging + volume); when one is boosted above 0 dB, lower every
    // track by that boost, so the balance still matches the mix.
    const playing = project.tracks.filter((track) => players.has(track.id));
    // The premix leaves saved-muted tracks out, so their boost doesn't count;
    // solo and listen-only mutes do, so toggling them keeps levels steady.
    const headroomDb = Math.max(
      0,
      ...playing.filter((track) => !track.muted).map(trackOutputGainDb),
    );
    for (const track of playing) {
      const el = players.get(track.id);
      if (!el) {
        continue;
      }
      el.volume = trackIsAudible(track.id, track.muted, viewerMute, soloTracks)
        ? Math.min(1, dbToLinear(trackOutputGainDb(track) - headroomDb))
        : 0;
    }
  }, [project, viewerMute, soloTracks, auditionMode, modeKey, enabled]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    for (const el of playersRef.current.values()) {
      el.playbackRate = playbackRate;
    }
  }, [playbackRate, enabled, modeKey]);

  useEffect(() => {
    const explicitSeek = appliedSeekRevision.current !== playheadSeekRevision;
    if (
      !enabled ||
      previewRef.current ||
      (drivingPlayheadRef.current && !explicitSeek) ||
      !project
    ) {
      return;
    }
    const threshold = explicitSeek ? 0 : isPlaying ? 0.5 : 0.12;
    seekPlayersToTimeline(
      playersRef.current,
      project,
      playheadSec,
      auditionMode,
      threshold,
    );
    appliedSeekRevision.current = playheadSeekRevision;
  }, [
    playheadSec,
    playheadSeekRevision,
    isPlaying,
    project,
    auditionMode,
    enabled,
  ]);

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
    if (!enabled) {
      return;
    }
    const players = [...playersRef.current.values()];
    if (players.length === 0) {
      if (isPlaying) {
        setIsPlaying(false);
      }
      return;
    }

    if (!isPlaying) {
      for (const el of players) {
        el.pause();
      }
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      drivingPlayheadRef.current = false;
      return;
    }

    let cancelled = false;
    const runEvents = new AbortController();
    const ownedPreview = previewRef.current;
    const startAt = ownedPreview?.startSec ?? playheadRef.current;
    const proj = projectRef.current;
    const mode = auditionModeRef.current;

    const waitFor = (
      el: HTMLAudioElement,
      event: "loadedmetadata" | "seeked",
    ) =>
      new Promise<void>((resolve, reject) => {
        const ready = () => {
          el.removeEventListener("error", failed);
          resolve();
        };
        const failed = () => {
          el.removeEventListener(event, ready);
          reject(new Error("audio load failed"));
        };
        el.addEventListener(event, ready, {
          once: true,
          signal: runEvents.signal,
        });
        el.addEventListener("error", failed, {
          once: true,
          signal: runEvents.signal,
        });
      });

    const run = async () => {
      try {
        for (const [key, el] of playersRef.current) {
          if (el.readyState < 1) {
            await waitFor(el, "loadedmetadata");
          }
          let mediaSec = startAt;
          if (!ownedPreview && mode === "raw" && key !== "premix" && proj) {
            mediaSec = rawSourceSec(proj, key, startAt) ?? startAt;
          }
          const target = Math.min(mediaSec, el.duration || mediaSec);
          if (Math.abs(el.currentTime - target) > 0.05) {
            const seeked = waitFor(el, "seeked");
            el.currentTime = target;
            await seeked;
          } else {
            el.currentTime = target;
          }
        }
        if (cancelled) {
          return;
        }
        await Promise.all(
          [...playersRef.current.values()].map((el) => el.play()),
        );
      } catch (e) {
        if (!cancelled) {
          const msg = errorMessage(e);
          const blocked =
            e instanceof DOMException && e.name === "NotAllowedError";
          if (ownedPreview) {
            updateSourcePreview(
              ownedPreview.ownerId,
              ownedPreview.generation,
              startAt,
              true,
              blocked
                ? {
                    kind: "blocked",
                    message:
                      "Browser blocked playback. Select the audio control again to try.",
                  }
                : { kind: "unavailable", message: msg },
            );
            return;
          }
          setAudioError(
            blocked
              ? "Browser blocked autoplay. Click Play in the transport"
              : msg,
          );
          setIsPlaying(false);
        }
        return;
      }

      if (cancelled) return;

      const seekAllToTimeline = (timelineSec: number) => {
        const projNow = projectRef.current;
        const modeNow = auditionModeRef.current;
        if (projNow) {
          seekPlayersToTimeline(
            playersRef.current,
            projNow,
            timelineSec,
            modeNow,
            0,
          );
        }
      };

      const stopAudition = (at: number) => {
        for (const el of playersRef.current.values()) {
          el.pause();
        }
        setPlayheadSec(at);
        setIsPlaying(false);
        setPlayUntilSec(null);
        clearSessionRegion();
      };

      // A Stop or Pause can land before this effect's cleanup; never write a stale clock over it.
      const tick = () => {
        meterMonitorRef.current?.sync();
        if (
          cancelled ||
          (ownedPreview
            ? previewRef.current?.ownerId !== ownedPreview.ownerId ||
              previewRef.current.generation !== ownedPreview.generation ||
              !previewRef.current.playing
            : !useDawStore.getState().isPlaying)
        ) {
          return;
        }
        const picked = pickMaster(playersRef.current);
        if (!picked) {
          return;
        }
        const [masterKey, master] = picked;
        if (ownedPreview) {
          const stopped =
            master.ended ||
            master.currentTime >= ownedPreview.endSec - AUDITION_STOP_EPS_SEC;
          updateSourcePreview(
            ownedPreview.ownerId,
            ownedPreview.generation,
            Math.min(master.currentTime, ownedPreview.endSec),
            stopped,
          );
          if (stopped) {
            master.pause();
            return;
          }
          rafRef.current = requestAnimationFrame(tick);
          return;
        }
        if (master && !master.paused && !master.ended) {
          const projNow = projectRef.current;
          const modeNow = auditionModeRef.current;
          let t =
            projNow != null
              ? masterTimelineSec(master, masterKey, projNow, modeNow)
              : master.currentTime;
          const skipped = nextPlayheadAfterSkip(
            t,
            playSkipStartRef.current,
            playSkipEndRef.current,
          );
          const jumped = skipped !== t;
          if (jumped) {
            t = skipped;
            seekAllToTimeline(t);
          }
          drivingPlayheadRef.current = true;
          setPlayheadSec(t, jumped ? "seek" : "playback");
          // Keep the flag through React's playhead effect (sync clear was a no-op).
          queueMicrotask(() => {
            drivingPlayheadRef.current = false;
          });
          const until = playUntilRef.current;
          if (until != null && t >= until - AUDITION_STOP_EPS_SEC) {
            const followup = playAbFollowupRef.current;
            if (followup) {
              playAbFollowupRef.current = null;
              for (const el of playersRef.current.values()) {
                el.pause();
              }
              continueAudition({
                playheadSec: followup.start,
                untilSec: followup.until,
                skip: { start: followup.skipStart, end: followup.skipEnd },
              });
              playSkipStartRef.current = followup.skipStart;
              playSkipEndRef.current = followup.skipEnd;
              playUntilRef.current = followup.until;
              const gapMs = Math.max(0, followup.gapSec) * 1000;
              const gen = auditionEpochRef.current;
              if (abTimerRef.current != null) {
                window.clearTimeout(abTimerRef.current);
              }
              abTimerRef.current = window.setTimeout(() => {
                abTimerRef.current = null;
                if (cancelled || auditionEpochRef.current !== gen) {
                  return;
                }
                seekAllToTimeline(followup.start);
                setPlayheadSec(followup.start);
                void Promise.all(
                  [...playersRef.current.values()].map((el) => el.play()),
                )
                  .then(() => {
                    if (!cancelled && auditionEpochRef.current === gen) {
                      rafRef.current = requestAnimationFrame(tick);
                    }
                  })
                  .catch((e: unknown) => {
                    if (cancelled || auditionEpochRef.current !== gen) {
                      return;
                    }
                    const msg = errorMessage(e);
                    const blocked =
                      e instanceof DOMException && e.name === "NotAllowedError";
                    setAudioError(
                      blocked
                        ? "Browser blocked autoplay. Click Play in the transport"
                        : msg,
                    );
                    setIsPlaying(false);
                  });
              }, gapMs);
              return;
            }
            stopAudition(until);
            return;
          }
          // Keep sibling raw players aligned to timeline as media clocks diverge at cuts.
          if (modeNow === "raw" && projNow) {
            for (const [key, el] of playersRef.current) {
              if (key === masterKey) {
                continue;
              }
              const sourceSec = rawSourceSec(projNow, key, t);
              if (sourceSec == null) {
                continue;
              }
              if (Math.abs(el.currentTime - sourceSec) > 0.35) {
                seekElement(el, sourceSec);
              }
            }
          }
          rafRef.current = requestAnimationFrame(tick);
          return;
        }
        if (master?.ended) {
          stopAudition(playUntilRef.current ?? master.currentTime);
        }
      };
      rafRef.current = requestAnimationFrame(tick);
    };

    void run();

    return () => {
      cancelled = true;
      runEvents.abort();
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
    enabled,
    isPlaying,
    preview?.generation,
    modeKey,
    setIsPlaying,
    setPlayheadSec,
    setPlayUntilSec,
    continueAudition,
    clearSessionRegion,
    setAudioError,
    updateSourcePreview,
  ]);
  useEffect(() => {
    if (!enabled) return;
    return bindPlaybackClock(() => {
      if (
        previewRef.current ||
        useDawStore.getState().projectEpoch !== projectEpoch
      )
        return null;
      const picked = pickMaster(playersRef.current);
      const projectNow = projectRef.current;
      if (
        !picked ||
        !projectNow ||
        picked[1].paused ||
        picked[1].ended ||
        picked[1].readyState < 2 ||
        picked[1].seeking
      )
        return null;
      return masterTimelineSec(
        picked[1],
        picked[0],
        projectNow,
        auditionModeRef.current,
      );
    });
  }, [enabled, projectEpoch, modeKey]);
  useEffect(() => {
    if (
      !enabled ||
      !projectRef.current ||
      previewRef.current ||
      isShareProjectKey(projectPath)
    )
      return;
    const monitor = createHostPlaybackMeterMonitor({
      clock: () => {
        const state = useDawStore.getState();
        const master = pickMaster(playersRef.current)?.[1];
        if (
          previewRef.current ||
          state.projectEpoch !== projectEpoch ||
          !state.isPlaying ||
          !master ||
          master.paused ||
          master.ended ||
          master.seeking ||
          master.readyState < 2
        )
          return null;
        return { playbackRate: state.playbackRate };
      },
      tracks: () => {
        const state = useDawStore.getState();
        const currentProject = projectRef.current;
        const master = pickMaster(playersRef.current);
        if (!currentProject || !master) return [];
        const mode = auditionModeRef.current;
        const timelineSec = masterTimelineSec(
          master[1],
          master[0],
          currentProject,
          mode,
        );
        return currentProject.tracks
          .filter((track) => trackHasAudioContent(track, currentProject))
          .map((track) => ({
            id: track.id,
            url: trackPlaybackUrl(
              currentProject,
              projectPath,
              track,
              mode === "raw" ? "raw" : "stem",
            ),
            gain: trackIsAudible(
              track.id,
              track.muted,
              state.viewerMute,
              state.soloTracks,
            )
              ? dbToLinear(trackOutputGainDb(track))
              : 0,
            mediaSec:
              mode === "raw"
                ? rawSourceSec(currentProject, track.id, timelineSec)
                : timelineSec,
          }));
      },
    });
    meterMonitorRef.current = monitor;
    const unbind = bindPlaybackMeterSource(monitor);
    return () => {
      unbind();
      monitor.dispose();
      if (meterMonitorRef.current === monitor) meterMonitorRef.current = null;
    };
  }, [enabled, projectPath, projectEpoch, modeKey]);

  useEffect(() => {
    meterMonitorRef.current?.sync();
  }, [timelineIsPlaying, preview, project, playbackRate, playheadSeekRevision]);
}
