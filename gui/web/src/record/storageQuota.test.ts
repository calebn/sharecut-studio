import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred } from "../test/deferred";
import { KEEPER_BYTES_PER_SECOND } from "./keeper/pcm";
import {
  assessStorageHeadroom,
  STORAGE_HEADROOM_SECONDS,
  useStorageHeadroom,
} from "./storageQuota";

describe("assessStorageHeadroom", () => {
  it("warns when estimated free space cannot hold an hour of keeper PCM", () => {
    const result = assessStorageHeadroom({
      usage: 0,
      quota: KEEPER_BYTES_PER_SECOND * (STORAGE_HEADROOM_SECONDS - 1),
    });
    expect(result.status).toBe("low");
    expect(result.message).toMatch(/free space/i);
  });

  it("handles unavailable or malformed estimates without claiming safety", () => {
    expect(assessStorageHeadroom().status).toBe("unknown");
    expect(assessStorageHeadroom({ quota: Number.NaN, usage: 0 }).status).toBe(
      "unknown",
    );
    expect(assessStorageHeadroom({ quota: 10, usage: 20 }).status).toBe("low");
  });

  it("accepts enough headroom", () => {
    expect(
      assessStorageHeadroom({
        usage: 1,
        quota: KEEPER_BYTES_PER_SECOND * STORAGE_HEADROOM_SECONDS + 1,
      }).status,
    ).toBe("sufficient");
  });
});

describe("useStorageHeadroom", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps one refresh command and accepts only the latest estimate", async () => {
    const initial = deferred<StorageEstimate>();
    const refreshed = deferred<StorageEstimate>();
    const estimate = vi
      .fn()
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(refreshed.promise);
    vi.stubGlobal("navigator", { storage: { estimate } });
    const { result, rerender } = renderHook(() => useStorageHeadroom());
    const refresh = result.current.refresh;
    expect(result.current.status).toBe("checking");
    rerender();
    expect(result.current.refresh).toBe(refresh);
    expect(estimate).toHaveBeenCalledTimes(1);
    let finishing!: Promise<void>;
    act(() => {
      finishing = refresh();
    });
    await act(async () => {
      refreshed.resolve({
        usage: 0,
        quota: KEEPER_BYTES_PER_SECOND * STORAGE_HEADROOM_SECONDS,
      });
      await finishing;
    });
    expect(result.current.status).toBe("sufficient");
    await act(async () => {
      initial.resolve({ usage: 0, quota: 1 });
    });
    expect(result.current.status).toBe("sufficient");
    expect(estimate).toHaveBeenCalledTimes(2);
  });

  it("reports unavailable storage without claiming headroom", async () => {
    vi.stubGlobal("navigator", {});
    const { result } = renderHook(() => useStorageHeadroom());
    expect(result.current.status).toBe("unknown");
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.status).toBe("unknown");
  });
});
