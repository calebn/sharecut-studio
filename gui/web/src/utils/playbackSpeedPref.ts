// Device-wide listening speed (#3816); only setPlaybackSpeed writes it, so scan and follow rates never persist.
import { readLocal, writeLocal } from "./storage";

export const PLAYBACK_SPEEDS = [1, 1.25, 1.5, 2] as const;

export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

export const PLAYBACK_SPEED_STORAGE_KEY = "sharecut.playbackSpeed";

export const DEFAULT_PLAYBACK_SPEED: PlaybackSpeed = 1;

export function isPlaybackSpeed(value: unknown): value is PlaybackSpeed {
  return PLAYBACK_SPEEDS.some((speed) => speed === value);
}

export function nextPlaybackSpeed(speed: number): PlaybackSpeed {
  const index = PLAYBACK_SPEEDS.findIndex((preset) => preset === speed);
  return PLAYBACK_SPEEDS[(index + 1) % PLAYBACK_SPEEDS.length]!;
}

export function formatPlaybackSpeed(rate: number): string {
  return `${rate}×`;
}

// A stored value that is not a preset (a stale "3", garbage) falls back to 1×.
export function readPlaybackSpeedPref(): PlaybackSpeed {
  const raw = readLocal(PLAYBACK_SPEED_STORAGE_KEY);
  if (raw === null) {
    return DEFAULT_PLAYBACK_SPEED;
  }
  const parsed = Number(raw);
  return isPlaybackSpeed(parsed) ? parsed : DEFAULT_PLAYBACK_SPEED;
}

export function writePlaybackSpeedPref(speed: PlaybackSpeed): void {
  writeLocal(PLAYBACK_SPEED_STORAGE_KEY, String(speed));
}
