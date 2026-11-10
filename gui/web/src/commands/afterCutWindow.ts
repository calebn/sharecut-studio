import { useDawStore } from "../state/dawStore";
import type { ProjectView } from "../types/project";

const WAIT_MS = 10_000;

export function transcriptLoading(project: ProjectView | null): boolean {
  return project?.meta.hydration?.transcript_words === false;
}

export function scriptBodyFocused(): boolean {
  const el = document.activeElement;
  if (!(el instanceof Element)) return false;
  if (el.closest(".sys-script-word, .sys-seam-hit") !== null) return true;
  return el.classList.contains("sys-script-body");
}

export function untilCutSettled(epoch: number): Promise<boolean> {
  return new Promise((resolve) => {
    const settle = (value: boolean) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(value);
    };
    const check = () => {
      const s = useDawStore.getState();
      if (s.projectEpoch !== epoch) return settle(false);
      if (!s.rangeBusy && !transcriptLoading(s.project)) settle(true);
    };
    const timer = setTimeout(() => settle(false), WAIT_MS);
    const unsubscribe = useDawStore.subscribe(check);
    check();
  });
}
