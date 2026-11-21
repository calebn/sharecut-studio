import { useCallback, useSyncExternalStore } from "react";
import {
  type OutboxView,
  outboxViewOf,
  subscribeOutbox,
} from "../state/outboxStore";

export function useOutbox(token: string | null): OutboxView {
  const follow = useCallback(
    (listener: () => void) =>
      token ? subscribeOutbox(token, listener) : () => undefined,
    [token],
  );
  return useSyncExternalStore(follow, () => outboxViewOf(token));
}
