import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject, offlineConflict } from "../test/fixtures";
import { GuestAttentionBanner } from "./GuestAttentionBanner";

const offlineStore = vi.hoisted(() => ({
  clearConflicts: vi.fn(),
  clearHostConflicts: vi.fn(),
  loadConflicts: vi.fn(),
  loadHostCommandCount: vi.fn(),
  loadHostConflicts: vi.fn(),
}));

vi.mock("../state/offlineStore", () => offlineStore);

describe("GuestAttentionBanner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const mock of Object.values(offlineStore)) {
      mock.mockReset();
    }
    offlineStore.clearConflicts.mockResolvedValue(undefined);
    offlineStore.clearHostConflicts.mockResolvedValue(undefined);
    offlineStore.loadConflicts.mockResolvedValue([]);
    offlineStore.loadHostCommandCount.mockResolvedValue(0);
    offlineStore.loadHostConflicts.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the host path: loadHostConflicts + loadHostCommandCount, never loadConflicts", async () => {
    offlineStore.loadHostCommandCount.mockResolvedValue(1);
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    render(<GuestAttentionBanner />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("1 pending")).toBeInTheDocument();
    expect(offlineStore.loadConflicts).not.toHaveBeenCalled();
    expect(offlineStore.loadHostConflicts).toHaveBeenCalledWith("/tmp/p.json");

    offlineStore.loadHostConflicts.mockResolvedValue([offlineConflict()]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Dismiss all" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(offlineStore.clearHostConflicts).toHaveBeenCalledWith("/tmp/p.json");
    expect(screen.getByText("1 pending")).toBeInTheDocument();
  });

  it("uses the share path: loadConflicts(token), no host command count", async () => {
    offlineStore.loadConflicts.mockResolvedValue([offlineConflict()]);
    useDawStore.getState().hydrate("share:tok-sample", minimalProject());
    render(<GuestAttentionBanner />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("1 conflict")).toBeInTheDocument();
    expect(offlineStore.loadConflicts).toHaveBeenCalledWith("tok-sample");
    expect(offlineStore.loadHostCommandCount).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Dismiss all" }));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(offlineStore.clearConflicts).toHaveBeenCalledWith("tok-sample");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("picks up a new count after the 2s poll", async () => {
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    render(<GuestAttentionBanner />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    offlineStore.loadHostCommandCount.mockResolvedValue(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByText("3 pending")).toBeInTheDocument();
  });

  it("leaves no alert when the loads reject", async () => {
    offlineStore.loadHostConflicts.mockRejectedValue(new Error("boom"));
    offlineStore.loadHostCommandCount.mockRejectedValue(new Error("boom"));
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    render(<GuestAttentionBanner />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
