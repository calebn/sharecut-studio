import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "zustand/vanilla";
import { batchDawWrites, useDawStore } from "./dawStore";
import {
  createSelectionSlice,
  localSelectionWriteSignal,
  selectionPatch,
} from "./selectionSlice";
import type { DawStore } from "./types";

beforeEach(() => useDawStore.getState().setSelection(null));

describe("local selection write ownership", () => {
  it("retains one write signal until an explicit empty clear", () => {
    const signal = localSelectionWriteSignal(useDawStore.getState);
    expect(localSelectionWriteSignal(useDawStore.getState)).toBe(signal);
    useDawStore.getState().setSelection(null);
    expect(signal.aborted).toBe(true);
    const next = localSelectionWriteSignal(useDawStore.getState);
    expect(next).not.toBe(signal);
    expect(next.aborted).toBe(false);
  });

  it("invalidates inside a batched no-op clear even when no store notification occurs", () => {
    const signal = localSelectionWriteSignal(useDawStore.getState);
    const changed = vi.fn();
    const unsubscribe = useDawStore.subscribe(changed);
    try {
      batchDawWrites(() => useDawStore.getState().setSelection(null));
      expect(changed).not.toHaveBeenCalled();
      expect(signal.aborted).toBe(true);
    } finally {
      unsubscribe();
    }
  });

  it("does not invalidate local intent when a wire selection patch is only computed", () => {
    const signal = localSelectionWriteSignal(useDawStore.getState);
    expect(selectionPatch(null, null, null).selection).toBeNull();
    expect(signal.aborted).toBe(false);
  });

  it("keeps independent stores' explicit writes separate", () => {
    const other = createStore<DawStore>()((...args) => ({
      ...useDawStore.getState(),
      ...createSelectionSlice(...args),
    }));
    const local = localSelectionWriteSignal(useDawStore.getState);
    const remoteStore = localSelectionWriteSignal(other.getState);
    other.getState().setSelection(null);
    expect(remoteStore.aborted).toBe(true);
    expect(local.aborted).toBe(false);
  });
});
