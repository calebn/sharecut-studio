/**
 * A set of listeners. `subscribe` returns an unsubscribe. `emit` calls a
 * snapshot, so a listener may subscribe or unsubscribe while it is notified.
 */
export type ListenerSet<A extends unknown[]> = {
  subscribe(listener: (...args: A) => void): () => void;
  emit(...args: A): void;
};

export function listenerSet<A extends unknown[] = []>(): ListenerSet<A> {
  const listeners = new Set<(...args: A) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(...args) {
      for (const fn of [...listeners]) {
        fn(...args);
      }
    },
  };
}
