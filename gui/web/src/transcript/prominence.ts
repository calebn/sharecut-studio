import type { ProsodyOverlay } from "../types/prosody";

/** Screen-reader note and tooltip for a prosodically prominent word (#719). */
export const PROMINENT_NOTE = "emphasized";
export const PROMINENT_TIP = "Emphasized (prosody)";

export function prominentWordKey(trackId: string, wordIndex: number): string {
  return `${trackId}\0${wordIndex}`;
}

/** Keys of every prominent word with a resolved `word_index` on a fresh or stale track. */
export function prominentWordKeys(
  overlay: ProsodyOverlay | null,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const track of overlay?.tracks ?? []) {
    if (track.status !== "fresh" && track.status !== "stale") continue;
    for (const w of track.prominent_words) {
      if (w.word_index != null)
        keys.add(prominentWordKey(track.track_id, w.word_index));
    }
  }
  return keys;
}
