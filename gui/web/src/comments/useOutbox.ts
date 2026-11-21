import { useCallback, useSyncExternalStore } from "react";
import {
  type OutboxView,
  outboxViewOf,
  subscribeOutbox,
} from "../state/outboxStore";

/** A guest's kept comments and replies, and the ones the host refused, as this device last read them. */
export function useOutbox(token: string | null): OutboxView {
  const follow = useCallback(
    (listener: () => void) =>
      token ? subscribeOutbox(token, listener) : () => undefined,
    [token],
  );
  return useSyncExternalStore(follow, () => outboxViewOf(token));
}
