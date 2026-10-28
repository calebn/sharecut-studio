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

/** Remember the audio a job was started on; a job nobody here started has no key. */
export function recordJobMedia(jobId: string, key: string | null): void {
  if (key !== null) keys.set(jobId, key);
}

export function jobMediaKey(jobId: string): string | undefined {
  return keys.get(jobId);
}
