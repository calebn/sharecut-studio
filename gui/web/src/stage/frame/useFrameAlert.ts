import { createContext, useContext, useEffect, useId, useRef } from "react";
import type { AlertSlotItem } from "../../system/AlertSlot";

/** Lower numbers are more urgent. */
export const FRAME_ALERT_PRIORITY = {
  failed: 10,
  needsYou: 20,
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
        entries.set(id, {
          priority,
          seq: entries.get(id)?.seq ?? seq++,
          item: { ...alert, id },
        });
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

export type FrameAlertEntry = FrameAlert & { id: string };

const FRAME_ALERT_LIST_SCALE = 1000;

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

/**
 * Puts a list of alerts in the frame's slot, already ordered most urgent
 * first. They outrank every other frame alert, and drop out when the list
 * shrinks or the caller unmounts.
 */
export function useFrameAlertList(alerts: readonly FrameAlertEntry[]) {
  const store = useContext(AlertStoreContext);
  const base = useId();
  const held = useRef(new Set<string>());
  useEffect(() => {
    if (!store) return;
    const now = new Set<string>();
    alerts.forEach(({ id, ...alert }, index) => {
      const key = `${base}:${id}`;
      now.add(key);
      store.set(key, index / FRAME_ALERT_LIST_SCALE, alert);
    });
    for (const key of held.current) if (!now.has(key)) store.set(key, 0, null);
    held.current = now;
  });
  useEffect(
    () => () => {
      for (const key of held.current) store?.set(key, 0, null);
      held.current = new Set();
    },
    [store],
  );
}
