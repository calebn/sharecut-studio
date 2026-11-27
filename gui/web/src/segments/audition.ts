import { useSyncExternalStore } from "react";
import { type SegmentRow, segmentAudioUrl } from "../api";
import { useDawStore } from "../state/dawStore";

export type AuditionState = {
  playingId: string | null;
  failedId: string | null;
  owner: string | null;
};

type Playing = {
  id: string;
  owner: string;
  version: number;
  clips: number;
  clip: number;
  urlFor?: (clip: number) => string;
};

const IDLE: AuditionState = { playingId: null, failedId: null, owner: null };

let audio: HTMLAudioElement | null = null;
let playing: Playing | null = null;
let snapshot: AuditionState = IDLE;
const listeners = new Set<() => void>();

function publish(next: AuditionState): void {
  if (
    next.playingId === snapshot.playingId &&
    next.failedId === snapshot.failedId &&
    next.owner === snapshot.owner
  ) {
    return;
  }
  snapshot = next;
  for (const listener of listeners) listener();
}

function onPageHide(): void {
  stopAudition();
}

function release(element: HTMLAudioElement): void {
  window.removeEventListener("pagehide", onPageHide);
  element.pause();
  element.removeAttribute("src");
  element.load();
}

function fail(id: string, owner: string): void {
  if (audio) release(audio);
  playing = null;
  publish({ playingId: null, failedId: id, owner });
}

function start(element: HTMLAudioElement, target: Playing): void {
  element.src =
    target.urlFor?.(target.clip) ??
    segmentAudioUrl(target.id, target.clip, target.version);
  Promise.resolve(element.play()).catch(() => {
    if (playing === target) fail(target.id, target.owner);
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
  if (playing) fail(playing.id, playing.owner);
}

function element(): HTMLAudioElement {
  if (audio) return audio;
  const created = new Audio();
  created.preload = "none";
  created.addEventListener("ended", onEnded);
  created.addEventListener("error", onError);
  audio = created;
  return created;
}

export function stopAudition(owner?: string): void {
  if (owner !== undefined) {
    const current = playing ? playing.owner : snapshot.owner;
    if (current !== owner) return;
  }
  playing = null;
  if (audio) release(audio);
  publish(IDLE);
}

/** `urlFor` names the audio of a row that is not in the library yet (a waiting import). */
export function toggleAudition(
  row: SegmentRow,
  owner: string,
  urlFor?: (clip: number) => string,
): void {
  if (playing?.id === row.id) {
    stopAudition();
    return;
  }
  if (row.clips.length === 0) {
    fail(row.id, owner);
    return;
  }
  // A segment Hear is local playback, so it ends follow like every other Hear.
  useDawStore.getState().stopFollow("local");
  const target = {
    id: row.id,
    owner,
    version: row.version,
    clips: row.clips.length,
    clip: 0,
    urlFor,
  };
  playing = target;
  publish({ playingId: row.id, failedId: null, owner });
  window.addEventListener("pagehide", onPageHide);
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
