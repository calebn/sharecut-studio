import { useDawStore } from "../state/dawStore";
import { subscribeMeterFrame } from "./meterFrameLoop";
import { DEFAULT_CLIP_DB, peakDbFromSamples } from "./metering";
import { setPlaybackTrackClipped } from "./playbackClipLatches";
import {
  playbackMeterSource,
  subscribePlaybackMeterSource,
} from "./playbackMeterSource";

/**
 * The live output level of each watched track, 0 to 1, for the track header's
 * ring. One frame loop reads every watched track and publishes at about 8 Hz,
 * in twelfths, so a header redraws only when its own twelfth changes and the
 * column never redraws for a frame. It also lights the clip latch of every
 * watched track, as the per-track meter did, so a clipped track stays lit
 * until the Track inspector clears it.
 */
export const TRACK_LEVEL_PUBLISH_MS = 125;
const LEVEL_STEPS = 12;
const LEVEL_FLOOR_DB = -60;

/** dBFS onto 0 to 1 across the floor to 0 dB; silence is 0. */
function levelFraction(db: number): number {
  if (!Number.isFinite(db)) return 0;
  return Math.min(1, Math.max(0, (db - LEVEL_FLOOR_DB) / -LEVEL_FLOOR_DB));
}

const watched = new Map<string, number>();
const levels = new Map<string, number>();
const listeners = new Set<() => void>();
let stopLoop: (() => void) | null = null;
let published = Number.NEGATIVE_INFINITY;

function reducedMotion(): boolean {
  return (
    window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true
  );
}

function isPlayingLive(): boolean {
  const s = useDawStore.getState();
  return s.isPlaying && s.sourcePreview === null;
}

function publish(): void {
  for (const listener of listeners) listener();
}

function clearLevels(): void {
  if (levels.size === 0) return;
  levels.clear();
  publish();
}

function frame(now: number): void {
  const source = playbackMeterSource();
  if (!source) return;
  const freeze = reducedMotion();
  let changed = false;
  const publishNow = now - published >= TRACK_LEVEL_PUBLISH_MS;
  for (const id of watched.keys()) {
    const samples = source.read(id);
    if (samples === null) continue;
    const db = peakDbFromSamples(samples);
    if (db >= DEFAULT_CLIP_DB) setPlaybackTrackClipped(id, true);
    if (freeze || !publishNow) continue;
    const next = Math.round(levelFraction(db) * LEVEL_STEPS) / LEVEL_STEPS;
    if ((levels.get(id) ?? 0) !== next) {
      levels.set(id, next);
      changed = true;
    }
  }
  if (publishNow) published = now;
  if (changed) publish();
}

function reconcile(): void {
  const wanted =
    watched.size > 0 && isPlayingLive() && playbackMeterSource() !== null;
  if (wanted && !stopLoop) {
    published = Number.NEGATIVE_INFINITY;
    stopLoop = subscribeMeterFrame(frame);
  } else if (!wanted && stopLoop) {
    stopLoop();
    stopLoop = null;
    clearLevels();
  }
}

let wasPlaying = false;
useDawStore.subscribe((state) => {
  const playing = state.isPlaying && state.sourcePreview === null;
  if (playing === wasPlaying) return;
  wasPlaying = playing;
  reconcile();
});
subscribePlaybackMeterSource(reconcile);

/** Watch one track's level; the returned function stops watching. */
export function watchTrackLevel(id: string): () => void {
  watched.set(id, (watched.get(id) ?? 0) + 1);
  reconcile();
  return () => {
    const count = (watched.get(id) ?? 1) - 1;
    if (count > 0) {
      watched.set(id, count);
    } else {
      watched.delete(id);
      if (levels.delete(id)) publish();
    }
    reconcile();
  };
}

export function subscribeTrackLevels(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function trackLevel(id: string): number {
  return levels.get(id) ?? 0;
}
