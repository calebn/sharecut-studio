import { useSyncExternalStore } from "react";
import { modalOpen, subscribeModalOpen } from "./modalGate";

/** True while any modal dialog is open, for chrome that must yield to it. */
export function useModalOpen(): boolean {
  return useSyncExternalStore(subscribeModalOpen, modalOpen, () => false);
}
