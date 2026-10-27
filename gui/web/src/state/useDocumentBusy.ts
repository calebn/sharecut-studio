import { useSyncExternalStore } from "react";
import {
  documentActivityBusy,
  subscribeDocumentActivity,
} from "./documentSendOrder";

/** A save, send or replay is in flight for this project in this tab. */
export function useDocumentBusy(projectPath: string): boolean {
  return useSyncExternalStore(subscribeDocumentActivity, () =>
    documentActivityBusy(projectPath),
  );
}
