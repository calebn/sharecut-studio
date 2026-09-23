import { plural } from "../utils/format";
import { readLocal, writeLocal } from "../utils/storage";

export const AUDIO_INGEST_EXTENSIONS = [
  ".wav",
  ".mp3",
  ".m4a",
  ".flac",
  ".aiff",
  ".aif",
  ".ogg",
] as const;

export function isAudioIngestFile(file: {
  name: string;
  type: string;
}): boolean {
  if (file.type.startsWith("audio/")) {
    return true;
  }
  const lower = file.name.toLowerCase();
  return AUDIO_INGEST_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function audioFilesFromDrop(list: FileList | File[]): File[] {
  return Array.from(list).filter(isAudioIngestFile);
}

/** Count file items on a drag (files.length is often 0 during dragover). */
export function fileCountFromDataTransfer(
  dt: Pick<DataTransfer, "items"> | null | undefined,
): number {
  if (!dt?.items) {
    return 0;
  }
  return Array.from(dt.items).filter((i) => i.kind === "file").length;
}

export function trackHasMedia(opts: {
  mediaPath?: string | null;
  clipCount: number;
}): boolean {
  return opts.clipCount > 0 || Boolean(opts.mediaPath);
}

/** Overlay while dragging over an existing lane. */
export function laneDropLabel(opts: {
  trackLabel: string;
  replacing: boolean;
  fileCount: number;
}): string {
  const name = opts.trackLabel || "track";
  if (opts.fileCount <= 1) {
    return opts.replacing ? `Replace ${name}` : `Add to ${name}`;
  }
  const extras = opts.fileCount - 1;
  const head = opts.replacing ? `1 replaces ${name}` : `1 adds to ${name}`;
  return `${head} · ${extras} new ${plural(extras, "track")}`;
}

/** Overlay while dragging onto the + Track / empty-session target. */
export function newTracksDropLabel(fileCount: number): string {
  if (fileCount <= 1) {
    return "Create new track";
  }
  return `Create ${fileCount} new tracks`;
}

export function replaceAudioConfirmMessage(trackLabel: string): string {
  const name = trackLabel || "this track";
  return (
    `${name} already has audio. Replace it?\n\n` +
    "Drop below the tracks (or on + Track) to add a new speaker instead."
  );
}

/** Compact duration for status announcements (e.g. "1:00", "0.5s"). */
export function formatIngestDuration(sec: number): string {
  const s = Math.max(0, sec);
  if (s < 60) {
    const rounded = Math.round(s * 10) / 10;
    return Number.isInteger(rounded) ? `${rounded}s` : `${rounded}s`;
  }
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}:${String(rem).padStart(2, "0")}`;
}

export const INGEST_COACH_STORAGE_KEY = "sharecut.ingestCoachDismissed";

export function isIngestCoachDismissed(): boolean {
  return readLocal(INGEST_COACH_STORAGE_KEY) === "1";
}

export function dismissIngestCoach(): void {
  writeLocal(INGEST_COACH_STORAGE_KEY, "1");
}
