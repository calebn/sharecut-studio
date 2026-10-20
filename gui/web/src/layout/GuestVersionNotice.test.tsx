import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadReviewVersionStatus, reviewVersionAtBootstrap } from "../api";
import { useDawStore } from "../state/dawStore";
import { DawProvider } from "../state/store";
import { minimalProject } from "../test/fixtures";
import { GuestVersionNotice } from "./GuestVersionNotice";

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

function mount(projectPath = "share:tok") {
  return render(
    <DawProvider projectPath={projectPath} initialProject={minimalProject()}>
      <GuestVersionNotice />
    </DawProvider>,
  );
}

describe("GuestVersionNotice", () => {
  beforeEach(() => {
    vi.mocked(loadReviewVersionStatus).mockReset();
    vi.mocked(reviewVersionAtBootstrap).mockReturnValue(null);
    useDawStore.getState().hydrate("share:tok", minimalProject());
  });

  it("shows the heard version of a frozen link", async () => {
    vi.mocked(loadReviewVersionStatus).mockResolvedValue(frozen);
    mount();
    expect((await screen.findByRole("status")).textContent).toContain(
      'Hearing "Cut 1"',
    );
    expect(loadReviewVersionStatus).toHaveBeenCalledWith(
      "tok",
      expect.any(AbortSignal),
    );
  });

  it("learns of a newer version when the tab comes back", async () => {
    vi.mocked(loadReviewVersionStatus).mockResolvedValue(frozen);
    mount();
    await screen.findByRole("status");
    vi.mocked(loadReviewVersionStatus).mockResolvedValue({
      ...frozen,
      newer: { id: "v2", label: "Cut 2" },
    });
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(
      await screen.findByText(/Newer version available: "Cut 2"/),
    ).toBeTruthy();
  });

  it("offers a reload when a following link moves to another version", async () => {
    vi.mocked(loadReviewVersionStatus).mockResolvedValue({
      ...frozen,
      followsLatest: true,
    });
    mount();
    await screen.findByText(/follows the latest version/);
    vi.mocked(loadReviewVersionStatus).mockResolvedValue({
      versionId: "v2",
      label: "Cut 2",
      followsLatest: true,
      newer: null,
    });
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(await screen.findByRole("button", { name: "Reload" })).toBeTruthy();
  });

  it("measures a change from the version the page loaded on, even when the first read failed", async () => {
    vi.mocked(reviewVersionAtBootstrap).mockReturnValue("v1");
    vi.mocked(loadReviewVersionStatus).mockRejectedValue(new Error("offline"));
    mount();
    await vi.waitFor(() =>
      expect(loadReviewVersionStatus).toHaveBeenCalledTimes(1),
    );
    vi.mocked(loadReviewVersionStatus).mockResolvedValue({
      versionId: "v2",
      label: "Cut 2",
      followsLatest: true,
      newer: null,
    });
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(await screen.findByRole("button", { name: "Reload" })).toBeTruthy();
  });

  it("keeps the last version when the read fails", async () => {
    vi.mocked(loadReviewVersionStatus).mockResolvedValue(frozen);
    mount();
    await screen.findByRole("status");
    vi.mocked(loadReviewVersionStatus).mockRejectedValue(new Error("offline"));
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await vi.waitFor(() =>
      expect(loadReviewVersionStatus).toHaveBeenCalledTimes(2),
    );
    expect(screen.getByRole("status").textContent).toContain('"Cut 1"');
  });

  it("renders nothing for a host project", () => {
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    mount("/tmp/p.json");
    expect(screen.queryByRole("status")).toBeNull();
    expect(loadReviewVersionStatus).not.toHaveBeenCalled();
  });
});
