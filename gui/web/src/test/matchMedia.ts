import { vi } from "vitest";

/** Stub a live media query for hooks that subscribe to its change event. */
export function stubMatchMedia(initial: boolean): {
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  setMatches: (next: boolean) => void;
} {
  let matches = initial;
  const listeners = new Set<() => void>();
  const addEventListener = vi.fn((_type: string, cb: () => void) => {
    listeners.add(cb);
  });
  const removeEventListener = vi.fn((_type: string, cb: () => void) => {
    listeners.delete(cb);
  });
  vi.stubGlobal("matchMedia", () => ({
    get matches() {
      return matches;
    },
    addEventListener,
    removeEventListener,
  }));
  return {
    addEventListener,
    removeEventListener,
    setMatches(next: boolean) {
      matches = next;
      for (const cb of listeners) {
        cb();
      }
    },
  };
}
