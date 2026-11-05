import { startInterval } from "./useIntervalTick";

function numberSample(read: () => number) {
  let value = read();
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    sample: () => {
      const next = read();
      if (Object.is(value, next)) return;
      value = next;
      for (const listener of listeners) listener();
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
