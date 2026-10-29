import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import type { HostRoom } from "./useHostRoom";

type RoomStore = {
  room: HostRoom | null;
  listeners: Set<() => void>;
};

const HostRoomContext = createContext<RoomStore | null>(null);

/** Holds the room in a store the context never replaces, so a selector's reader re-renders only when its pick changes. */
export function HostRoomProvider({
  value,
  children,
}: {
  value: HostRoom | null;
  children?: ReactNode;
}) {
  const store = useRef<RoomStore>(null);
  store.current ??= { room: value, listeners: new Set() };
  const current = store.current;
  useLayoutEffect(() => {
    current.room = value;
    for (const listener of current.listeners) listener();
  }, [current, value]);
  return createElement(HostRoomContext.Provider, { value: current }, children);
}

function useSubscribe(store: RoomStore | null) {
  return useCallback(
    (listener: () => void) => {
      store?.listeners.add(listener);
      return () => {
        store?.listeners.delete(listener);
      };
    },
    [store],
  );
}

export function useHostRoomContext(): HostRoom | null {
  const store = useContext(HostRoomContext);
  return useSyncExternalStore(useSubscribe(store), () => store?.room ?? null);
}

/** A value derived from the room; the reader re-renders only when `equal` says it changed. */
export function useHostRoomSelector<T>(
  select: (room: HostRoom | null) => T,
  equal: (a: T, b: T) => boolean,
): T {
  const store = useContext(HostRoomContext);
  const last = useRef<{ value: T } | null>(null);
  return useSyncExternalStore(useSubscribe(store), () => {
    const value = select(store?.room ?? null);
    if (last.current && equal(last.current.value, value)) {
      return last.current.value;
    }
    last.current = { value };
    return value;
  });
}
