import { createContext, useContext, useEffect, useId } from "react";
import type { AlertSlotItem } from "../../system/AlertSlot";

/** Lower numbers are more urgent. */
export const FRAME_ALERT_PRIORITY = {
  failed: 10,
} as const;

export type FrameAlert = Omit<AlertSlotItem, "id">;

type Entry = { priority: number; seq: number; item: AlertSlotItem };

export function createAlertStore() {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let snapshot: readonly AlertSlotItem[] = [];
  let seq = 0;
  return {
    set(id: string, priority: number, alert: FrameAlert | null) {
      if (alert)
        entries.set(id, { priority, seq: seq++, item: { ...alert, id } });
      else if (!entries.delete(id)) return;
      snapshot = [...entries.values()]
        .sort((a, b) => a.priority - b.priority || b.seq - a.seq)
        .map((entry) => entry.item);
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
  };
}

export type AlertStore = ReturnType<typeof createAlertStore>;

export const AlertStoreContext = createContext<AlertStore | null>(null);

/**
 * Puts one alert in the frame's slot while `alert` is set. Alerts sort by
 * `priority`; the most urgent shows and the rest sit behind "+N".
 */
export function useFrameAlert(priority: number, alert: FrameAlert | null) {
  const store = useContext(AlertStoreContext);
  const id = useId();
  useEffect(() => {
    store?.set(id, priority, alert);
  });
  useEffect(() => () => store?.set(id, 0, null), [store, id]);
}
