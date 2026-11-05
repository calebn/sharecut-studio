import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import { useDawStore } from "../../state/dawStore";
import { minimalProject, offlineConflict } from "../../test/fixtures";
import { GuestAttentionBanner } from "./GuestAttentionBanner";

const offlineStore = vi.hoisted(() => {
  const state = {
    clearConflicts: vi.fn(),
    clearHostConflicts: vi.fn(),
    dismissConflicts: vi.fn(),
    dismissHostConflicts: vi.fn(),
    loadConflicts: vi.fn(),
    loadCommandQueue: vi.fn(),
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
    loadGuestAttention: vi.fn(async (token: string) => {
      const [, conflicts] = await Promise.all([
        state.loadCommandQueue(token),
        state.loadConflicts(token),
      ]);
      return { pending: 0, conflicts };
    }),
  };
});

vi.mock("../../services/offlineQueue/offlineStore", () => offlineStore);

function openDetails() {
  const details = screen.getByLabelText(/^Needs attention (?:\d+|!) Details$/);
  if (!details.closest("details")?.hasAttribute("open"))
    fireEvent.click(details);
}

function getActionButton(name: string) {
  openDetails();
  return screen.getByRole("button", { name });
}

beforeEach(() => {
  clearRegisteredCommands();
  registerDawCommands();
});

afterEach(() => {
  clearRegisteredCommands();
});

describe("GuestAttentionBanner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const mock of Object.values(offlineStore)) {
      mock.mockReset();
    }
    offlineStore.clearConflicts.mockResolvedValue(undefined);
    offlineStore.clearHostConflicts.mockResolvedValue(undefined);
    offlineStore.dismissConflicts.mockResolvedValue({
      pending: 0,
      conflicts: [],
    });
    offlineStore.dismissHostConflicts.mockImplementation(async (path) => ({
      pending: await offlineStore.loadHostCommandCount(path),
      conflicts: [],
    }));
    offlineStore.loadConflicts.mockResolvedValue([]);
    offlineStore.loadCommandQueue.mockResolvedValue([]);
    offlineStore.loadHostCommandCount.mockResolvedValue(0);
    offlineStore.loadHostConflicts.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses the share path: loadConflicts(token), no host command count", async () => {
    offlineStore.loadConflicts.mockResolvedValue([offlineConflict()]);
    useDawStore.getState().hydrate("share:tok-sample", minimalProject());
    render(<GuestAttentionBanner />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(
      screen.getByRole("region", { name: /Needs attention/ }),
    ).toHaveAccessibleName(/1 conflict/);
    expect(offlineStore.loadConflicts).toHaveBeenCalledWith("tok-sample");
    expect(offlineStore.loadHostCommandCount).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(getActionButton("Dismiss all"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(offlineStore.dismissConflicts).toHaveBeenCalledWith("tok-sample", [
      expect.objectContaining({ command: expect.any(Object) }),
    ]);
    expect(
      screen.queryByRole("region", { name: /Needs attention/ }),
    ).not.toBeInTheDocument();
  });

  it("gives guests a reachable History recovery instruction", async () => {
    const conflict = offlineConflict({
      kind: "unknown",
      reason: "Undo or Redo may have been applied.",
      recovery: "inspect-history",
      command: { type: "UndoHistory" },
    });
    offlineStore.loadConflicts.mockResolvedValue([conflict]);
    useDawStore.getState().hydrate("share:tok-sample", minimalProject());
    render(<GuestAttentionBanner />);
    await act(() => vi.advanceTimersByTimeAsync(0));

    openDetails();
    expect(
      screen.getByRole("region", { name: /Needs attention/ }),
    ).toHaveTextContent(
      "Ask the project owner to inspect History before trying this action again.",
    );
    expect(
      screen.queryByRole("button", { name: "Inspect History" }),
    ).not.toBeInTheDocument();
  });

  it("shows unreadable guest queued edits without changing the guest pending count", async () => {
    offlineStore.loadCommandQueue.mockRejectedValue(
      new Error("Invalid saved command"),
    );
    useDawStore.getState().hydrate("share:tok-sample", minimalProject());
    render(<GuestAttentionBanner />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    openDetails();
    expect(
      screen.getByRole("region", { name: /Needs attention/ }),
    ).toHaveTextContent("Your saved edits have been kept.");
    expect(
      screen.queryByRole("button", { name: "Dismiss all" }),
    ).not.toBeInTheDocument();
    offlineStore.loadCommandQueue.mockResolvedValue([]);
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(
      screen.queryByRole("region", { name: /Needs attention/ }),
    ).not.toBeInTheDocument();
  });

  it("tells a guest that an uncertain command retries automatically", async () => {
    offlineStore.loadConflicts.mockResolvedValue([
      offlineConflict({
        kind: "unknown",
        reason: "The server may have applied this edit.",
        recovery: "retry-same-command",
      }),
    ]);
    useDawStore.getState().hydrate("share:automatic-retry", minimalProject());
    render(<GuestAttentionBanner />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    openDetails();
    expect(
      screen.getByRole("region", { name: /Needs attention/ }),
    ).toHaveTextContent("The app will retry this same command automatically.");
    expect(
      screen.queryByRole("button", { name: "Send now" }),
    ).not.toBeInTheDocument();
  });
});
