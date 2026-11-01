import type { TrackView } from "../types/project";
import { useDawStore } from "./dawStore";

const keys = new Map<string, string>();

export function mediaKeyOf(tracks: readonly TrackView[] | undefined): string {
  return (tracks ?? [])
    .filter((t) => t.role === "dialogue" && t.media_path)
    .map((t) => `${t.id}:${t.media_path}`)
    .sort()
    .join("|");
}

/** The source audio on the open project now, or null while it loads. */
export function currentMediaKey(): string | null {
  const project = useDawStore.getState().project;
  return project ? mediaKeyOf(project.tracks) : null;
}

const TRANSCRIBE_STEP = "transcribe_tracks";
const STEPS_BEFORE_TRANSCRIBE: readonly string[] = ["ingest_tracks"];

/** Whether a run with these step limits transcribes the sources; a later start step skips it. */
export function runIncludesTranscribe(run: {
  fromStep?: string | null;
  onlyStep?: string | null;
}): boolean {
  if (run.onlyStep) return run.onlyStep === TRANSCRIBE_STEP;
  return (
    !run.fromStep ||
    run.fromStep === TRANSCRIBE_STEP ||
    STEPS_BEFORE_TRANSCRIBE.includes(run.fromStep)
  );
}

/** Remember the audio a job was started on; a job nobody here started has no key. */
export function recordJobMedia(jobId: string, key: string | null): void {
  if (key === null) return;
  keys.set(jobId, key);
  // Kept for this tab so a reload still knows which audio the last run covered.
  const saved = savedKeys();
  delete saved[jobId];
  saved[jobId] = key;
  const ids = Object.keys(saved);
  for (const old of ids.slice(0, Math.max(0, ids.length - SAVED_JOBS))) {
    delete saved[old];
  }
  try {
    window.sessionStorage.setItem(SAVED_KEY, JSON.stringify(saved));
  } catch {
    /* private window: the memory copy still serves this page load */
  }
}

export function jobMediaKey(jobId: string): string | undefined {
  return keys.get(jobId) ?? savedKeys()[jobId];
}

const SAVED_KEY = "sharecut.jobMedia";
const SAVED_JOBS = 20;

function savedKeys(): Record<string, string> {
  try {
    const raw = window.sessionStorage.getItem(SAVED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}
