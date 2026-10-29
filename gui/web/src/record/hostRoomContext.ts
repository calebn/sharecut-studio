import {
  createContext,
  createElement,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from "react";
import type { HostRoom } from "./useHostRoom";

type RoomStore = {
  room: HostRoom | null;
  listeners: Set<() => void>;
  publish: (room: HostRoom | null) => void;
};

function createRoomStore(room: HostRoom | null): RoomStore {
  const store: RoomStore = {
    room,
    listeners: new Set(),
    publish(next) {
      store.room = next;
      for (const listener of store.listeners) listener();
    },
  };
  return store;
}

/** Keeps the last pick, so an equal one returns the same value and the reader does not re-render. */
function createPicker<T>(): (value: T, equal: (a: T, b: T) => boolean) => T {
  let last: { value: T } | null = null;
  return (value, equal) => {
    if (last && equal(last.value, value)) {
      return last.value;
    }
    last = { value };
    return value;
  };
}

const HostRoomContext = createContext<RoomStore | null>(null);

/** Holds the room in a store the context never replaces, so a selector's reader re-renders only when its pick changes. */
export function HostRoomProvider({
  value,
  children,
}: {
  value: HostRoom | null;
  children?: ReactNode;
}) {
  const [store] = useState(() => createRoomStore(value));
  useLayoutEffect(() => {
    store.publish(value);
  }, [store, value]);
  return createElement(HostRoomContext.Provider, { value: store }, children);
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
  const [pick] = useState(createPicker<T>);
  return useSyncExternalStore(useSubscribe(store), () =>
    pick(select(store?.room ?? null), equal),
  );
}
