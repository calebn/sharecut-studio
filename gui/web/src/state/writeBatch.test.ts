import { describe, expect, it, vi } from "vitest";
import { create } from "zustand";
import { createWriteBatch } from "./writeBatch";

type Counters = { a: number; b: number };

function makeStore() {
  const { middleware, batch } = createWriteBatch<Counters>();
  const store = create<Counters>()(middleware(() => ({ a: 0, b: 0 })));
  return { store, batch };
}

describe("createWriteBatch", () => {
  it("notifies once with (final, pre-batch) state", () => {
    const { store, batch } = makeStore();
    const listener = vi.fn();
    const before = store.getState();
    store.subscribe(listener);
    batch(() => {
      store.setState({ a: 1 });
      store.setState({ b: 2 });
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ a: 1, b: 2 }),
      before,
    );
  });

  it("reads see pending writes inside the batch", () => {
    const { store, batch } = makeStore();
    const seen: number[] = [];
    batch(() => {
      store.setState({ a: 1 });
      seen.push(store.getState().a);
      store.setState({ a: store.getState().a + 1 });
      seen.push(store.getState().a);
    });
    expect(seen).toEqual([1, 2]);
    expect(store.getState().a).toBe(2);
  });

  it("a no-op batch does not notify", () => {
    const { store, batch } = makeStore();
    const listener = vi.fn();
    store.subscribe(listener);
    batch(() => {
      // no writes
    });
    expect(listener).not.toHaveBeenCalled();
  });

  it("a batch that writes back the same state does not notify", () => {
    const { store, batch } = makeStore();
    const listener = vi.fn();
    store.subscribe(listener);
    batch(() => {
      const s = store.getState();
      store.setState({ a: s.a, b: s.b });
    });
    expect(listener).not.toHaveBeenCalled();
  });

  it("nested batches commit once, at the outermost exit", () => {
    const { store, batch } = makeStore();
    const listener = vi.fn();
    store.subscribe(listener);
    batch(() => {
      store.setState({ a: 1 });
      batch(() => {
        store.setState({ b: 2 });
      });
      expect(listener).not.toHaveBeenCalled();
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getState()).toMatchObject({ a: 1, b: 2 });
  });

  it("writes outside a batch pass straight through", () => {
    const { store } = makeStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.setState({ a: 5 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getState().a).toBe(5);
  });

  it("a throwing job still commits pending writes and rethrows", () => {
    const { store, batch } = makeStore();
    expect(() =>
      batch(() => {
        store.setState({ a: 9 });
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(store.getState().a).toBe(9);
  });

  it("replace works: a full-state set inside a batch discards other pending fields", () => {
    const { store, batch } = makeStore();
    batch(() => {
      store.setState({ a: 1 });
      store.setState({ a: 42, b: 7 }, true);
    });
    expect(store.getState()).toEqual({ a: 42, b: 7 });
  });

  it("a real-store case: several slice-style writes fold into one render", () => {
    const { middleware, batch } = createWriteBatch<{
      playheadSec: number;
      isPlaying: boolean;
      setPlayheadSec: (sec: number) => void;
      setIsPlaying: (v: boolean) => void;
    }>();
    const store = create<{
      playheadSec: number;
      isPlaying: boolean;
      setPlayheadSec: (sec: number) => void;
      setIsPlaying: (v: boolean) => void;
    }>()(
      middleware((set) => ({
        playheadSec: 0,
        isPlaying: false,
        setPlayheadSec: (playheadSec) => set({ playheadSec }),
        setIsPlaying: (isPlaying) => set({ isPlaying }),
      })),
    );
    const listener = vi.fn();
    store.subscribe(listener);
    batch(() => {
      store.getState().setPlayheadSec(3.5);
      store.getState().setIsPlaying(true);
    });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getState()).toMatchObject({
      playheadSec: 3.5,
      isPlaying: true,
    });
  });
});
