import { startInterval } from "./useIntervalTick";

function cachedSample<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    publish: (next: T) => {
      if (Object.is(value, next)) return;
      value = next;
      for (const listener of listeners) listener();
    },
  };
}

function numberSample(read: () => number) {
  const clock = cachedSample(read());
  return {
    getSnapshot: clock.getSnapshot,
    subscribe: clock.subscribe,
    sample: () => clock.publish(read()),
  };
}

export function createActiveElapsedSample() {
  const clock = cachedSample<number | null>(null);
  return {
    getSnapshot: clock.getSnapshot,
    subscribe: clock.subscribe,
    connect: (active: boolean) => {
      if (!active) {
        clock.publish(null);
        return () => {};
      }
      const started = Date.now();
      clock.publish(0);
      return startInterval(1000, () => {
        clock.publish(Math.floor((Date.now() - started) / 1000));
      });
    },
  };
}

export function createWallSample() {
  const clock = numberSample(() => Date.now() / 1000);
  return {
    getSnapshot: clock.getSnapshot,
    subscribe: clock.subscribe,
    connect: (enabled: boolean) => {
      if (!enabled) return () => {};
      clock.sample();
      return startInterval(1000, clock.sample);
    },
  };
}

export function createElapsedSample() {
  const clock = numberSample(() => performance.now());
  let startMs: number | null = null;
  return {
    getSnapshot: clock.getSnapshot,
    subscribe: clock.subscribe,
    setStart: (start: number | null) => {
      startMs = start;
      if (startMs !== null) clock.sample();
    },
    connect: (active: boolean) => {
      if (!active) return () => {};
      return startInterval(1000, () => {
        if (startMs !== null) clock.sample();
      });
    },
  };
}
