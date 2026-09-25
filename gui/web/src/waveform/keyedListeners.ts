/** Listeners grouped by a string key (a pyramid or PCM key). */
export type KeyedListeners = {
  /** Returns an unsubscribe. */
  subscribe(key: string, listener: () => void): () => void;
  notify(key: string): void;
  clear(): void;
};

export function keyedListeners(): KeyedListeners {
  const map = new Map<string, Set<() => void>>();
  return {
    subscribe(key, listener) {
      let set = map.get(key);
      if (!set) {
        set = new Set();
        map.set(key, set);
      }
      const own = set;
      own.add(listener);
      return () => {
        own.delete(listener);
        if (own.size === 0 && map.get(key) === own) {
          map.delete(key);
        }
      };
    },
    notify(key) {
      for (const fn of [...(map.get(key) ?? [])]) {
        fn();
      }
    },
    clear() {
      map.clear();
    },
  };
}
