import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { warmPendingPreview } from "../audio/pendingPreview";
import { useDawStore } from "../state/dawStore";
import { minimalProject, pendingEditView } from "../test/fixtures";
import {
  PENDING_MIX_WARM_DEBOUNCE_MS,
  PENDING_MIX_WARM_RETRY_MS,
  usePendingMixWarm,
} from "./usePendingMixWarm";

vi.mock("../audio/pendingPreview", () => ({
  warmPendingPreview: vi.fn(async () => true),
}));

function open(pending: boolean) {
  const project = minimalProject();
  project.pending_edits = pending
    ? [pendingEditView({ id: "cut", review_required: true })]
    : [];
  useDawStore.getState().hydrate("/tmp/ep.json", project);
}

describe("usePendingMixWarm", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(warmPendingPreview).mockReset().mockResolvedValue(true);
    useDawStore.setState({ guestMode: null });
  });
  afterEach(() => vi.useRealTimers());

  it("measures the mix alone once the project with pending edits settles", async () => {
    open(true);
    renderHook(() => usePendingMixWarm(true));
    expect(warmPendingPreview).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(PENDING_MIX_WARM_DEBOUNCE_MS));
    expect(warmPendingPreview).toHaveBeenCalledWith("/tmp/ep.json", null);
  });

  it("does nothing for a project with no edit awaiting review", async () => {
    open(false);
    renderHook(() => usePendingMixWarm(true));
    await act(() =>
      vi.advanceTimersByTimeAsync(PENDING_MIX_WARM_DEBOUNCE_MS * 3),
    );
    expect(warmPendingPreview).not.toHaveBeenCalled();
  });

  it("does nothing when sync is off (guest or share)", async () => {
    open(true);
    renderHook(() => usePendingMixWarm(false));
    await act(() =>
      vi.advanceTimersByTimeAsync(PENDING_MIX_WARM_DEBOUNCE_MS * 3),
    );
    expect(warmPendingPreview).not.toHaveBeenCalled();
  });

  it("asks again after a busy host, a few times", async () => {
    vi.mocked(warmPendingPreview).mockResolvedValue(false);
    open(true);
    renderHook(() => usePendingMixWarm(true));
    await act(() => vi.advanceTimersByTimeAsync(PENDING_MIX_WARM_DEBOUNCE_MS));
    await act(() => vi.advanceTimersByTimeAsync(PENDING_MIX_WARM_RETRY_MS));
    await act(() => vi.advanceTimersByTimeAsync(PENDING_MIX_WARM_RETRY_MS));
    await act(() => vi.advanceTimersByTimeAsync(PENDING_MIX_WARM_RETRY_MS * 3));
    expect(warmPendingPreview).toHaveBeenCalledTimes(3);
  });
});
