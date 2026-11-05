import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AttentionSnapshot } from "../../services/offlineQueue/offlineAttention";
import { useDawStore } from "../../state/dawStore";
import { minimalProject, offlineConflict } from "../../test/fixtures";
import { stubViewportShell } from "../../test/viewportShell";
import { ReviewHost } from "./ReviewHost";

const attention = vi.hoisted(() => ({
  snapshot: null as unknown as AttentionSnapshot,
  use: vi.fn(),
  dismissAll: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("../../services/offlineQueue/offlineAttention", () => ({
  useOfflineAttention: (path: string | null) => {
    attention.use(path);
    return path ? attention.snapshot : { ...attention.snapshot, conflicts: [] };
  },
  dismissAllConflicts: attention.dismissAll,
  refreshOfflineAttention: attention.refresh,
}));

const snapshot = (
  over: Partial<AttentionSnapshot> = {},
): AttentionSnapshot => ({
  pending: 0,
  conflicts: [
    offlineConflict({ command: { command_id: "c1", type: "TrimClip" } }),
    {
      ...offlineConflict({ command: { command_id: "gone" } }),
      dismissed: true,
    },
  ],
  recoverySelection: null,
  status: "ready",
  loaded: true,
  settling: false,
  ...over,
});

function open(path: string, mode: "view" | "comment" | "edit" | null) {
  useDawStore
    .getState()
    .hydrate(
      path,
      minimalProject({ timeline_duration_sec: 60 }),
      mode ?? undefined,
    );
  useDawStore.setState({ stage: "review", selection: null });
}

describe("Review queue attention rows", () => {
  beforeEach(() => {
    stubViewportShell("desktop");
    attention.snapshot = snapshot();
    attention.use.mockReset();
    attention.dismissAll.mockReset();
    attention.refresh.mockReset();
  });

  it("lists active conflicts for a share key and wires Dismiss all", async () => {
    open("share:tok", "comment");
    render(<ReviewHost guestShare />);
    expect(attention.use).toHaveBeenCalledWith("share:tok");
    const group = screen.getByRole("group", {
      name: "Needs attention. 1 conflict",
    });
    expect(group).toHaveTextContent("TrimClip:");
    await userEvent.click(screen.getByRole("button", { name: "Dismiss all" }));
    expect(attention.dismissAll).toHaveBeenCalledWith("share:tok");
  });

  it("appends the recovery selection and calls refresh from Retry", async () => {
    const recovered = {
      ...offlineConflict({ command: { command_id: "gone" }, reason: "Old" }),
      dismissed: true,
    };
    attention.snapshot = snapshot({
      recoverySelection: recovered,
      status: "unreadable",
    });
    open("share:tok", "comment");
    render(<ReviewHost guestShare />);
    expect(
      screen.getByRole("group", {
        name: "Needs attention. 2 conflicts. Saved edits could not be read",
      }),
    ).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(attention.refresh).toHaveBeenCalledWith("share:tok");
  });

  it("gives a host project no attention rows and reads nothing", () => {
    open("/tmp/host.sharecut", null);
    render(<ReviewHost />);
    expect(attention.use).toHaveBeenCalledWith(null);
    expect(screen.queryByRole("group", { name: /Needs attention/ })).toBeNull();
  });
});
