import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useMemo,
  useSyncExternalStore,
} from "react";
import { AlertSlot, type AlertSlotItem } from "../../system/AlertSlot";

/** Lower numbers are more urgent. */
export const FRAME_ALERT_PRIORITY = {
  failed: 10,
  needsYou: 20,
} as const;

export type FrameAlert = Omit<AlertSlotItem, "id">;

type Entry = { priority: number; item: AlertSlotItem };

function createAlertStore() {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let snapshot: readonly AlertSlotItem[] = [];
  return {
    set(id: string, priority: number, alert: FrameAlert | null) {
      if (alert) entries.set(id, { priority, item: { ...alert, id } });
      else if (!entries.delete(id)) return;
      snapshot = [...entries.values()]
        .sort((a, b) => a.priority - b.priority)
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

type AlertStore = ReturnType<typeof createAlertStore>;

const AlertStoreContext = createContext<AlertStore | null>(null);

function FrameAlertSlot({ store }: { store: AlertStore }) {
  const alerts = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  return <AlertSlot alerts={alerts} />;
}

/** Hosts the frame's one alert slot; every `useFrameAlert` below it lands in that slot. */
export function FrameAlerts({ children }: { children: ReactNode }) {
  const store = useMemo(createAlertStore, []);
  return (
    <AlertStoreContext.Provider value={store}>
      {children}
      <FrameAlertSlot store={store} />
    </AlertStoreContext.Provider>
  );
}

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
