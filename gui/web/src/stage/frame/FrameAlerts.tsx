import {
  type ReactNode,
  useContext,
  useState,
  useSyncExternalStore,
} from "react";
import { AlertSlot } from "../../system/AlertSlot";
import { AlertStoreContext, createAlertStore } from "./useFrameAlert";

/** Holds the frame's alerts. Mount it above the whole frame so the banners and the stage body share it. */
export function FrameAlertProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createAlertStore);
  return (
    <AlertStoreContext.Provider value={store}>
      {children}
    </AlertStoreContext.Provider>
  );
}

/** The frame's one alert slot; it shows what every `useFrameAlert` under the provider put there. */
export function FrameAlertSlot() {
  const store = useContext(AlertStoreContext);
  if (!store) throw new Error("FrameAlertSlot needs a FrameAlertProvider");
  const alerts = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  return <AlertSlot alerts={alerts} />;
}

/** A provider and its slot in one, for a tree that has no frame around it. */
export function FrameAlerts({ children }: { children: ReactNode }) {
  return (
    <FrameAlertProvider>
      <FrameAlertSlot />
      {children}
    </FrameAlertProvider>
  );
}
