import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import type { ReviewVersion } from "./useReviewVersion";

const loadReviewPeaks = vi.fn();
vi.mock("../api", () => ({
  loadReviewPeaks: (...args: unknown[]) => loadReviewPeaks(...args),
  reviewVersionAtBootstrap: () => null,
}));

import { useReviewPeaks } from "./useReviewPeaks";

const read = (versionId: string): ReviewVersion => ({
  versionId,
  label: null,
  followsLatest: true,
  changed: false,
});

function share(token: string) {
  useDawStore
    .getState()
    .hydrate(`share:${token}`, minimalProject({ timeline_duration_sec: 100 }));
  useDawStore.setState({ shareCapabilities: ["play", "comment"] });
}

beforeEach(() => {
  loadReviewPeaks.mockReset();
  useDawStore.setState({ reviewPeaks: [] });
  share("tok");
});

describe("useReviewPeaks", () => {
  it("asks for the version it is given and stores the answer", async () => {
    loadReviewPeaks.mockResolvedValue([0.5, 1]);
    renderHook(() => useReviewPeaks(read("v1")));
    await vi.waitFor(() =>
      expect(useDawStore.getState().reviewPeaks).toEqual([0.5, 1]),
    );
    expect(loadReviewPeaks).toHaveBeenCalledWith("tok", "v1");
  });

  it("clears the old version's peaks the moment the version changes", async () => {
    loadReviewPeaks.mockResolvedValueOnce([0.5, 1]);
    const { rerender } = renderHook(({ v }) => useReviewPeaks(v), {
      initialProps: { v: read("v1") },
    });
    await vi.waitFor(() =>
      expect(useDawStore.getState().reviewPeaks).toEqual([0.5, 1]),
    );
    loadReviewPeaks.mockReturnValueOnce(new Promise(() => undefined));
    rerender({ v: read("v2") });
    expect(useDawStore.getState().reviewPeaks).toEqual([]);
    expect(loadReviewPeaks).toHaveBeenLastCalledWith("tok", "v2");
  });

  it("retries a failed fetch on the next poll and not before", async () => {
    loadReviewPeaks.mockResolvedValueOnce([]).mockResolvedValueOnce([0.2, 1]);
    const { rerender } = renderHook(({ v }) => useReviewPeaks(v), {
      initialProps: { v: read("v1") },
    });
    await act(async () => undefined);
    expect(loadReviewPeaks).toHaveBeenCalledTimes(1);
    rerender({ v: read("v1") });
    await vi.waitFor(() =>
      expect(useDawStore.getState().reviewPeaks).toEqual([0.2, 1]),
    );
    expect(loadReviewPeaks).toHaveBeenCalledTimes(2);
  });

  it("drops the peaks when the page switches to another share", async () => {
    loadReviewPeaks.mockResolvedValueOnce([0.5, 1]);
    const { rerender } = renderHook(() => useReviewPeaks(read("v1")));
    await vi.waitFor(() =>
      expect(useDawStore.getState().reviewPeaks).toEqual([0.5, 1]),
    );
    loadReviewPeaks.mockReturnValue(new Promise(() => undefined));
    act(() => share("other"));
    rerender();
    expect(useDawStore.getState().reviewPeaks).toEqual([]);
  });

  it("ignores an answer for the old version that arrives after a version change", async () => {
    let resolveOld: (p: number[]) => void = () => undefined;
    loadReviewPeaks.mockReturnValueOnce(
      new Promise<number[]>((r) => {
        resolveOld = r;
      }),
    );
    const { rerender } = renderHook(({ v }) => useReviewPeaks(v), {
      initialProps: { v: read("v1") },
    });
    loadReviewPeaks.mockReturnValueOnce(new Promise(() => undefined));
    rerender({ v: read("v2") });
    await act(async () => {
      resolveOld([0.9, 1]);
    });
    expect(useDawStore.getState().reviewPeaks).toEqual([]);
  });

  it("does not fetch when the link may not play", async () => {
    useDawStore.setState({ shareCapabilities: ["comment"] });
    renderHook(() => useReviewPeaks(read("v1")));
    await act(async () => undefined);
    expect(loadReviewPeaks).not.toHaveBeenCalled();
    expect(useDawStore.getState().reviewPeaks).toEqual([]);
  });
});
