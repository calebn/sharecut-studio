import { type ReactNode, useState, useSyncExternalStore } from "react";
import { AlertSlot } from "../../system/AlertSlot";
import {
  type AlertStore,
  AlertStoreContext,
  createAlertStore,
} from "./useFrameAlert";

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
  const [store] = useState(createAlertStore);
  return (
    <AlertStoreContext.Provider value={store}>
      <FrameAlertSlot store={store} />
      {children}
    </AlertStoreContext.Provider>
  );
}
