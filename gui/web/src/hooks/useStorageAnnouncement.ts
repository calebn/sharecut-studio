import { useEffect, useRef } from "react";
import { useDawStore } from "../state/dawStore";
import {
  PREFS_SENTENCE,
  type StorageHealth,
  storageSentence,
  useStorageHealth,
} from "../state/storageHealth";

function sentencesOf(health: StorageHealth): string[] {
  const kept = health.snapshot ?? health.queue;
  return [
    ...(kept ? [storageSentence(kept)] : []),
    ...(health.prefs ? [PREFS_SENTENCE] : []),
  ];
}

/** Speaks each sentence once; it repeats only after the failure has cleared and come back. */
export function useStorageAnnouncement(): void {
  const health = useStorageHealth();
  const spoken = useRef(new Set<string>());
  useEffect(() => {
    const now = new Set(sentencesOf(health));
    for (const sentence of now) {
      if (spoken.current.has(sentence)) continue;
      spoken.current.add(sentence);
      useDawStore.getState().announceStatus(sentence, { toast: false });
    }
    for (const sentence of [...spoken.current])
      if (!now.has(sentence)) spoken.current.delete(sentence);
  }, [health]);
}
