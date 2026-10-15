import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GuestAttentionBanner } from "../layout/GuestAttentionBanner";
import { StatusBar } from "../layout/StatusBar";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { expectOutsideLiveRegions } from "../test/a11y";
import { minimalProject } from "../test/fixtures";

const offlineStore = vi.hoisted(() => {
  const state = {
    dismissHostConflicts: vi.fn(),
    loadHostCommandCount: vi.fn(),
    loadHostConflicts: vi.fn(),
  };
  return {
    ...state,
    loadHostAttention: vi.fn(async (path: string) => {
      const [pending, conflicts] = await Promise.all([
        state.loadHostCommandCount(path),
        state.loadHostConflicts(path),
      ]);
      return { pending, conflicts };
    }),
    loadGuestAttention: vi.fn(async () => ({ pending: 0, conflicts: [] })),
  };
});

vi.mock("../state/offlineStore", () => offlineStore);

describe("useOfflineAttentionAnnouncement", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    offlineStore.loadHostCommandCount.mockResolvedValue(0);
    offlineStore.loadHostConflicts.mockResolvedValue([]);
    offlineStore.dismissHostConflicts.mockResolvedValue({
      pending: 0,
      conflicts: [],
    });
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    useDawStore.setState({ statusAnnouncement: "", statusAnnouncementSeq: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("announces attention changes politely without duplicating the region label", async () => {
    offlineStore.loadHostCommandCount.mockResolvedValue(2);
    const { container } = render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <GuestAttentionBanner />
        <StatusBar />
      </DawProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const region = screen.getByRole("region", {
      name: "Needs attention. 2 pending",
    });
    expectOutsideLiveRegions(container, /^Attention$/);
    const polite = screen.getByRole("status");
    expect(polite.getAttribute("aria-live")).toBe("polite");
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Needs attention. 2 pending",
    );
    expect(polite.textContent).toBe("Needs attention. 2 pending");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(region).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(useDawStore.getState().statusAnnouncementSeq).toBe(1);
  });

  it("announces unreadable saved edits before the first successful read", async () => {
    offlineStore.loadHostConflicts.mockRejectedValue(new Error("idb"));
    offlineStore.loadHostCommandCount.mockRejectedValue(new Error("idb"));
    render(
      <DawProvider projectPath="/tmp/p.json" initialProject={minimalProject()}>
        <GuestAttentionBanner />
        <StatusBar />
      </DawProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(useDawStore.getState().statusAnnouncement).toMatch(
      /Saved edits could not be read/,
    );
    expect(useDawStore.getState().statusAnnouncementSeq).toBe(1);
  });
});
