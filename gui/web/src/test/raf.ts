import { vi } from "vitest";

type RafCallback = (t: number) => void;

/**
 * Stub requestAnimationFrame with a manual clock: `fire(t)` runs every
 * pending callback once with timestamp `t`; `cancelAnimationFrame` really
 * drops the callback. Pair with `vi.unstubAllGlobals()`.
 */
export function stubRaf() {
  const pending = new Map<number, RafCallback>();
  let nextId = 1;
  vi.stubGlobal("requestAnimationFrame", (cb: RafCallback) => {
    const id = nextId++;
    pending.set(id, cb);
    return id;
  });
  const cancel = vi.fn((id: number) => {
    pending.delete(id);
  });
  vi.stubGlobal("cancelAnimationFrame", cancel);
  return {
    cancel,
    pendingCount: () => pending.size,
    fire(t: number) {
      // Snapshot: a tick schedules the next frame while running.
      const batch = [...pending.values()];
      pending.clear();
      for (const cb of batch) cb(t);
    },
  };
}
