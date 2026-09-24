import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mediaQuerySubscription,
  useMediaQueryStore,
} from "./useMediaQueryStore";

afterEach(() => vi.unstubAllGlobals());

describe("useMediaQueryStore", () => {
  it("reads the first snapshot, tracks change, and removes every listener", () => {
    let matches = false;
    const listeners = new Set<() => void>();
    const addEventListener = vi.fn((_event: string, listener: () => void) => {
      listeners.add(listener);
    });
    const removeEventListener = vi.fn(
      (_event: string, listener: () => void) => {
        listeners.delete(listener);
      },
    );
    vi.stubGlobal("matchMedia", () => ({
      get matches() {
        return matches;
      },
      addEventListener,
      removeEventListener,
    }));
    const extraCleanup = vi.fn();
    const subscribeExtra = vi.fn(() => extraCleanup);
    const subscribe = mediaQuerySubscription(
      ["(pointer: fine)"],
      subscribeExtra,
    );
    const { result, unmount } = renderHook(() =>
      useMediaQueryStore(
        subscribe,
        () => matches,
        () => false,
      ),
    );
    expect(result.current).toBe(false);
    expect(addEventListener).toHaveBeenCalledWith(
      "change",
      expect.any(Function),
    );
    act(() => {
      matches = true;
      for (const listener of listeners) listener();
    });
    expect(result.current).toBe(true);
    unmount();
    expect(removeEventListener).toHaveBeenCalledWith(
      "change",
      expect.any(Function),
    );
    expect(listeners.size).toBe(0);
    expect(extraCleanup).toHaveBeenCalledOnce();
  });
});
