import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadReviewVersionStatus, reviewVersionAtBootstrap } from "../api";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { SANITY_POLL_MS } from "../state/syncCadence";
import { minimalProject } from "../test/fixtures";
import { useReviewVersion } from "./useReviewVersion";

vi.mock("../api", () => ({
  loadReviewVersionStatus: vi.fn(),
  reviewVersionAtBootstrap: vi.fn(() => null),
}));

const frozen = {
  versionId: "v1",
  label: "Cut 1",
  followsLatest: false,
  newer: null,
};
const following = { ...frozen, followsLatest: true };
const moved = {
  versionId: "v2",
  label: "Cut 2",
  followsLatest: true,
  newer: null,
};

function mount(projectPath = "share:tok") {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <DawProvider projectPath={projectPath} initialProject={minimalProject()}>
      {children}
    </DawProvider>
  );
  return renderHook(() => useReviewVersion(), { wrapper });
}

function wake() {
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
}

describe("useReviewVersion", () => {
  beforeEach(() => {
    vi.mocked(loadReviewVersionStatus).mockReset();
    vi.mocked(reviewVersionAtBootstrap).mockReturnValue(null);
    useDawStore.getState().hydrate("share:tok", minimalProject());
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reads the version of a frozen link and does not call it changed", async () => {
    vi.mocked(loadReviewVersionStatus).mockResolvedValue(frozen);
    const { result } = mount();
    expect(result.current).toBeNull();
    await waitFor(() =>
      expect(result.current).toEqual({
        versionId: "v1",
        label: "Cut 1",
        followsLatest: false,
        changed: false,
      }),
    );
    expect(loadReviewVersionStatus).toHaveBeenCalledWith(
      "tok",
      expect.any(AbortSignal),
    );
  });

  it("never calls a frozen link changed, even when a newer version exists", async () => {
    vi.mocked(loadReviewVersionStatus).mockResolvedValue(frozen);
    const { result } = mount();
    await waitFor(() => expect(result.current).not.toBeNull());
    vi.mocked(loadReviewVersionStatus).mockResolvedValue({
      ...frozen,
      newer: { id: "v2", label: "Cut 2" },
    });
    wake();
    await waitFor(() =>
      expect(loadReviewVersionStatus).toHaveBeenCalledTimes(2),
    );
    expect(result.current?.changed).toBe(false);
    expect(result.current?.label).toBe("Cut 1");
  });

  it("reports a following link as changed when it moves to another version", async () => {
    vi.mocked(loadReviewVersionStatus).mockResolvedValue(following);
    const { result } = mount();
    await waitFor(() => expect(result.current?.followsLatest).toBe(true));
    expect(result.current?.changed).toBe(false);
    vi.mocked(loadReviewVersionStatus).mockResolvedValue(moved);
    wake();
    await waitFor(() =>
      expect(result.current).toEqual({
        versionId: "v2",
        label: "Cut 2",
        followsLatest: true,
        changed: true,
      }),
    );
  });

  it("measures a change from the version the page loaded on, even when the first read failed", async () => {
    vi.mocked(reviewVersionAtBootstrap).mockReturnValue("v1");
    vi.mocked(loadReviewVersionStatus).mockRejectedValue(new Error("offline"));
    const { result } = mount();
    await waitFor(() =>
      expect(loadReviewVersionStatus).toHaveBeenCalledTimes(1),
    );
    expect(result.current).toBeNull();
    vi.mocked(loadReviewVersionStatus).mockResolvedValue(moved);
    wake();
    await waitFor(() => expect(result.current?.changed).toBe(true));
  });

  it("takes the first read as the baseline when the page never saw a version", async () => {
    vi.mocked(loadReviewVersionStatus).mockResolvedValue(following);
    const { result } = mount();
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(result.current?.changed).toBe(false);
  });

  it("ignores a read with no version id and keeps the last value", async () => {
    vi.mocked(loadReviewVersionStatus).mockResolvedValue(frozen);
    const { result } = mount();
    await waitFor(() => expect(result.current?.label).toBe("Cut 1"));
    vi.mocked(loadReviewVersionStatus).mockResolvedValue({
      ...frozen,
      versionId: null,
      label: "Other",
    });
    wake();
    await waitFor(() =>
      expect(loadReviewVersionStatus).toHaveBeenCalledTimes(2),
    );
    expect(result.current?.label).toBe("Cut 1");
  });

  it("keeps the last version when a read fails", async () => {
    vi.mocked(loadReviewVersionStatus).mockResolvedValue(frozen);
    const { result } = mount();
    await waitFor(() => expect(result.current?.label).toBe("Cut 1"));
    vi.mocked(loadReviewVersionStatus).mockRejectedValue(new Error("offline"));
    wake();
    await waitFor(() =>
      expect(loadReviewVersionStatus).toHaveBeenCalledTimes(2),
    );
    expect(result.current?.label).toBe("Cut 1");
  });

  it("reads again when the tab becomes visible", async () => {
    vi.mocked(loadReviewVersionStatus).mockResolvedValue(frozen);
    mount();
    await waitFor(() =>
      expect(loadReviewVersionStatus).toHaveBeenCalledTimes(1),
    );
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() =>
      expect(loadReviewVersionStatus).toHaveBeenCalledTimes(2),
    );
  });

  it("reads again every SANITY_POLL_MS", async () => {
    vi.useFakeTimers();
    vi.mocked(loadReviewVersionStatus).mockResolvedValue(frozen);
    mount();
    await act(async () => {});
    expect(loadReviewVersionStatus).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(SANITY_POLL_MS - 1);
    });
    expect(loadReviewVersionStatus).toHaveBeenCalledTimes(1);
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(loadReviewVersionStatus).toHaveBeenCalledTimes(2);
  });

  it("stays null and reads nothing for a host project", () => {
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    const { result } = mount("/tmp/p.json");
    wake();
    expect(result.current).toBeNull();
    expect(loadReviewVersionStatus).not.toHaveBeenCalled();
  });
});
