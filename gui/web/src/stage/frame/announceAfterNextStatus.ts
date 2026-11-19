import { useDawStore } from "../../state/dawStore";

/** An edit that announces nothing of its own still gets its reminder spoken. */
export const QUIET_EDIT_FALLBACK_MS = 1500;

/**
 * Says `text` in the status slot after the next announcement lands, or after a
 * quiet spell. The slot holds one sentence, so a reminder spoken first would be
 * replaced by the edit's own status a moment later.
 */
export function announceAfterNextStatus(text: string): void {
  const spokenAt = useDawStore.getState().statusAnnouncementSeq;
  const speak = () => {
    unsubscribe();
    clearTimeout(timer);
    useDawStore.getState().announceStatus(text, { toast: false });
  };
  const unsubscribe = useDawStore.subscribe((state) => {
    if (state.statusAnnouncementSeq !== spokenAt) {
      unsubscribe();
      clearTimeout(timer);
      queueMicrotask(speak);
    }
  });
  const timer = setTimeout(speak, QUIET_EDIT_FALLBACK_MS);
}
