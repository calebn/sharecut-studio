import { readLocal, writeLocal } from "../../utils/storage";

/** The pipeline step the "Scan for sounds" switch stands for. */
export const SOUND_SCAN_STEP = "apply_sound_actions";
/** The setting that gates the step (it is a no-op without it). */
export const SOUND_SCAN_PATH = "tighten.apply_non_speech";

/** What the scan costs, in plain units (#2889 measures about 150 s on 30 minutes). */
export const SOUND_SCAN_COST = "about 2½ minutes for 30 minutes of audio";
const SCAN_SECONDS_PER_AUDIO_SECOND = 150 / (30 * 60);

/** "about 2 min 30 s" for audio of this length, to the nearest 10 s. */
export function soundScanTime(audioSec: number): string {
  const total = Math.max(
    10,
    Math.round((audioSec * SCAN_SECONDS_PER_AUDIO_SECOND) / 10) * 10,
  );
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes === 0) return `about ${seconds} s`;
  return seconds === 0
    ? `about ${minutes} min`
    : `about ${minutes} min ${seconds} s`;
}

/** The person's own choice, per browser: "New projects start with this". */
const START_KEY = "sharecut.soundScanForNewProjects";

/** Off unless the person turned it on. */
export function readSoundScanStart(): boolean {
  return readLocal(START_KEY) === "on";
}

export function writeSoundScanStart(on: boolean): void {
  writeLocal(START_KEY, on ? "on" : "off");
}
