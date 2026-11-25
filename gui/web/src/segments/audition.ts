import { useSyncExternalStore } from "react";
import { type SegmentRow, segmentAudioUrl } from "../api";

export type AuditionState = {
  playingId: string | null;
  failedId: string | null;
};

type Playing = { id: string; version: number; clips: number; clip: number };

const IDLE: AuditionState = { playingId: null, failedId: null };

let audio: HTMLAudioElement | null = null;
let playing: Playing | null = null;
let snapshot: AuditionState = IDLE;
const listeners = new Set<() => void>();

function publish(next: AuditionState): void {
  if (
    next.playingId === snapshot.playingId &&
    next.failedId === snapshot.failedId
  ) {
    return;
  }
  snapshot = next;
  for (const listener of listeners) listener();
}

function release(element: HTMLAudioElement): void {
  element.pause();
  element.removeAttribute("src");
  element.load();
}

function fail(id: string): void {
  if (audio) release(audio);
  playing = null;
  publish({ playingId: null, failedId: id });
}

function start(element: HTMLAudioElement, target: Playing): void {
  element.src = segmentAudioUrl(target.id, target.clip, target.version);
  Promise.resolve(element.play()).catch(() => {
    if (playing === target) fail(target.id);
  });
}

function onEnded(): void {
  const current = playing;
  if (!audio || !current) return;
  if (current.clip + 1 < current.clips) {
    const next = { ...current, clip: current.clip + 1 };
    playing = next;
    start(audio, next);
    return;
  }
  stopAudition();
}

function onError(): void {
  if (playing) fail(playing.id);
}

function element(): HTMLAudioElement {
  if (audio) return audio;
  const created = new Audio();
  created.preload = "none";
  created.addEventListener("ended", onEnded);
  created.addEventListener("error", onError);
  window.addEventListener("pagehide", stopAudition);
  audio = created;
  return created;
}

export function stopAudition(): void {
  playing = null;
  if (audio) release(audio);
  publish(IDLE);
}

export function toggleAudition(row: SegmentRow): void {
  if (playing?.id === row.id) {
    stopAudition();
    return;
  }
  if (row.clips.length === 0) {
    fail(row.id);
    return;
  }
  const target = {
    id: row.id,
    version: row.version,
    clips: row.clips.length,
    clip: 0,
  };
  playing = target;
  publish({ playingId: row.id, failedId: null });
  start(element(), target);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAudition(): AuditionState {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => IDLE,
  );
}
