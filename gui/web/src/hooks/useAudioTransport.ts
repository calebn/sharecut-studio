import { useEffect, useRef } from "react";
import { audioUrl } from "../api";
import { useDawStore } from "../state/dawStore";
import { useDaw } from "../state/useDaw";
import { trackOutputGainDb } from "../tracks/trackMix";
import type { ProjectView } from "../types/project";
import { errorMessage } from "../utils/apiError";
import { anySolo, dbToLinear, trackIsAudible } from "../utils/audio";
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
    setPlayheadSec,
    isPlaying,
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
  } = useDaw();

  const playersRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  const rafRef = useRef<number | null>(null);
  const abTimerRef = useRef<number | null>(null);
  const playheadRef = useRef(playheadSec);
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
  const modeKey = `${auditionMode}:${needsMultitrack ? "mt" : "premix"}:${fxKey}`;

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
          setAudioError(`Failed to load audio (${key})`);
          setIsPlaying(false);
        },
        { signal: playerEvents.signal },
      );
      players.set(key, el);
      el.playbackRate = useDawStore.getState().playbackRate;
    };

    if (!needsMultitrack && auditionMode === "mix") {
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
        if (kind === "raw") {
          make(track.id, audioUrl(projectPath, kind, track.id));
          continue;
        }
        const stale = track.stem_is_fresh === false;
        const cacheKey = `${track.stem_is_fresh ? "f" : "s"}-${(
          project.effects_by_track[track.id] ?? []
        )
          .map((e) => `${e.effect}:${e.bypass ? 1 : 0}`)
          .join(",")}`;
        make(
          track.id,
          audioUrl(projectPath, kind, track.id, {
            rerender: stale,
            cacheKey,
          }),
        );
      }
    }

    const t = playheadRef.current;
    for (const [key, el] of players) {
      const mediaSec =
        auditionMode === "raw" && key !== "premix"
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
    project,
    projectPath,
    projectEpoch,
    modeKey,
    needsMultitrack,
    auditionMode,
    setAudioError,
    setIsPlaying,
  ]);

  useEffect(() => {
    if (!enabled || !project) {
      return;
    }
    const players = playersRef.current;
    const premix = players.get("premix");
    if (premix) {
      premix.volume = 1;
      return;
    }
    const audible = project.tracks.filter(
      (track) =>
        players.has(track.id) &&
        trackIsAudible(track.id, track.muted, viewerMute, soloTracks),
    );
    // Media elements can't boost (volume <= 1), so play each track at its
    // output gain (staging + fader) relative to the loudest audible one: the
    // balance matches the mix, a little quieter overall.
    const loudestDb = Math.max(...audible.map(trackOutputGainDb));
    for (const track of project.tracks) {
      const el = players.get(track.id);
      if (!el) {
        continue;
      }
      el.volume = audible.includes(track)
        ? Math.min(1, dbToLinear(trackOutputGainDb(track) - loudestDb))
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

  // External seek (paused scrub, or large agent jump while playing).
  // While playing, ignore small deltas — transport RAF owns the clock; session
  // heartbeats used to re-seek every ~200ms and stutter the WAV.
  useEffect(() => {
    if (!enabled || drivingPlayheadRef.current || !project) {
      return;
    }
    const threshold = isPlaying ? 0.5 : 0.12;
    seekPlayersToTimeline(
      playersRef.current,
      project,
      playheadSec,
      auditionMode,
      threshold,
    );
  }, [playheadSec, isPlaying, project, auditionMode, enabled]);

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
    const startAt = playheadRef.current;
    const proj = projectRef.current;
    const mode = auditionModeRef.current;

    const waitFor = (
      el: HTMLAudioElement,
      event: "loadedmetadata" | "seeked",
    ) =>
      new Promise<void>((resolve, reject) => {
        const onErr = () => reject(new Error("audio load failed"));
        el.addEventListener(event, () => resolve(), { once: true });
        el.addEventListener("error", onErr, { once: true });
      });

    const run = async () => {
      try {
        for (const [key, el] of playersRef.current) {
          if (el.readyState < 1) {
            await waitFor(el, "loadedmetadata");
          }
          let mediaSec = startAt;
          if (mode === "raw" && key !== "premix" && proj) {
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
          setAudioError(
            blocked
              ? "Browser blocked autoplay. Click Play in the transport"
              : msg,
          );
          setIsPlaying(false);
        }
        return;
      }

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

      const tick = () => {
        if (cancelled) {
          return;
        }
        const picked = pickMaster(playersRef.current);
        if (!picked) {
          return;
        }
        const [masterKey, master] = picked;
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
          if (skipped !== t) {
            t = skipped;
            seekAllToTimeline(t);
          }
          drivingPlayheadRef.current = true;
          setPlayheadSec(t);
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
    modeKey,
    setIsPlaying,
    setPlayheadSec,
    setPlayUntilSec,
    continueAudition,
    clearSessionRegion,
    setAudioError,
  ]);
}
