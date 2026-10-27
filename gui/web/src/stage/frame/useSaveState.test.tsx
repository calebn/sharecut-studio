import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import type { OfflineConflict } from "../../services/offlineQueue/offlineStore";
import { useDawStore } from "../../state/dawStore";
import { beginDocumentSend } from "../../state/documentSendOrder";
import { SaveIndicator } from "../../system/SaveIndicator";
import { minimalProject, offlineConflict } from "../../test/fixtures";
import { GuestAttentionBanner } from "./GuestAttentionBanner";
import { ATTENTION_BANNER_ID } from "./GuestAttentionBannerView";
import { saveIndicatorOf } from "./useSaveIndicator";
import { useSaveState } from "./useSaveState";

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
const drain = vi.hoisted(() => ({ requestHostDrain: vi.fn() }));

vi.mock("../../services/offlineQueue/offlineStore", () => offlineStore);
vi.mock("../../services/offlineQueue/drainOfflineQueue", () => drain);

const PATH = "/tmp/save-state-1448.json";

/** The save state as the header shows it, plus what pressing it does. */
function SaveDot() {
  const { state, attention } = useSaveState();
  return (
    <>
      <span data-testid="attention" data-kind={attention.kind} />
      {state ? <SaveIndicator {...saveIndicatorOf(state, attention)} /> : null}
    </>
  );
}

async function settle(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function openDetails() {
  const details = screen.getByLabelText(
    "Needs attention details and recovery actions",
  );
  if (!details.closest("details")?.hasAttribute("open"))
    fireEvent.click(details);
}

function getActionButton(name: string) {
  openDetails();
  return screen.getByRole("button", { name });
}

function mountBannerTarget() {
  const banner = document.createElement("div");
  banner.id = ATTENTION_BANNER_ID;
  banner.tabIndex = -1;
  document.body.append(banner);
  return banner;
}

beforeEach(() => {
  clearRegisteredCommands();
  registerDawCommands();
  vi.useFakeTimers();
  for (const mock of [
    ...Object.values(offlineStore),
    ...Object.values(drain),
  ]) {
    mock.mockReset();
  }
  offlineStore.loadHostCommandCount.mockResolvedValue(0);
  offlineStore.loadHostConflicts.mockResolvedValue([]);
  offlineStore.dismissHostConflicts.mockResolvedValue({
    pending: 0,
    conflicts: [],
  });
  offlineStore.loadConflicts.mockResolvedValue([]);
  offlineStore.loadCommandQueue.mockResolvedValue([]);
  drain.requestHostDrain.mockResolvedValue(undefined);
  useDawStore.getState().hydrate(PATH, minimalProject(), null);
});

afterEach(() => {
  vi.useRealTimers();
  clearRegisteredCommands();
});

describe("useSaveState", () => {
  it("shows nothing until the queue has been read, then Saved", async () => {
    render(<SaveDot />);
    expect(screen.queryByRole("status")).toBeNull();
    await settle();
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
  });

  it("stays Saved when the only refusal is an Undo with nothing to undo", async () => {
    offlineStore.loadHostConflicts.mockResolvedValue([
      offlineConflict({
        command: { type: "UndoHistory" },
        reason: "Nothing to undo",
      }),
    ]);
    render(<SaveDot />);
    await settle();
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
  });

  it("reads Saving while a send is in flight and Saved once it ends", async () => {
    render(<SaveDot />);
    await settle();
    let send!: ReturnType<typeof beginDocumentSend>;
    act(() => {
      send = beginDocumentSend(PATH, "cmd-1");
    });
    expect(screen.getByRole("status")).toHaveTextContent("Saving");
    act(() => send.finish());
    await settle();
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
  });

  it("never reads Saved between a failed send and the queue read that follows it", async () => {
    render(<SaveDot />);
    await settle();
    let send!: ReturnType<typeof beginDocumentSend>;
    act(() => {
      send = beginDocumentSend(PATH, "cmd-late");
    });
    let release!: (count: number) => void;
    offlineStore.loadHostCommandCount.mockReturnValue(
      new Promise<number>((resolve) => {
        release = resolve;
      }),
    );
    act(() => send.finish());
    expect(screen.getByRole("status")).toHaveTextContent("Saving");
    await settle(500);
    expect(screen.getByRole("status")).not.toHaveTextContent("Saved");
    await act(async () => {
      release(1);
    });
    await settle();
    expect(screen.getByRole("status")).toHaveTextContent("1 waiting");
    expect(screen.queryByText("Saved")).toBeNull();
  });

  it("reads the queue as soon as a send ends, not at the next poll", async () => {
    render(<SaveDot />);
    await settle();
    let send!: ReturnType<typeof beginDocumentSend>;
    act(() => {
      send = beginDocumentSend(PATH, "cmd-2");
    });
    offlineStore.loadHostCommandCount.mockResolvedValue(1);
    act(() => send.finish());
    await settle();
    expect(screen.getByRole("status")).toHaveTextContent("1 waiting");
  });

  it("stays saved on a refused edit and the Needs attention banner gives the reason", async () => {
    offlineStore.loadHostConflicts.mockResolvedValue([
      offlineConflict({ reason: "The clip moved" }),
    ]);
    render(
      <>
        <SaveDot />
        <GuestAttentionBanner />
      </>,
    );
    await settle();
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
    const banner = screen.getByRole("region", { name: /Needs attention/ });
    openDetails();
    expect(banner).toHaveTextContent("The clip moved");
  });

  it("moves focus to Needs attention when a failed save's Retry is pressed", async () => {
    const blocking = {
      ...offlineConflict({ reason: "The project file is missing." }),
      blocksSave: true,
    } as OfflineConflict;
    offlineStore.loadHostConflicts.mockResolvedValue([blocking]);
    const banner = mountBannerTarget();
    render(<SaveDot />);
    await settle();
    expect(screen.getByTestId("attention")).toHaveAttribute(
      "data-kind",
      "button",
    );
    fireEvent.click(screen.getByRole("button", { name: /Retry/ }));
    expect(banner).toHaveFocus();
    expect(drain.requestHostDrain).not.toHaveBeenCalled();
    banner.remove();
  });

  it("fails on unreadable saved edits, is not pressable, and the banner offers Retry", async () => {
    offlineStore.loadHostCommandCount.mockRejectedValueOnce(new Error("idb"));
    const target = mountBannerTarget();
    render(
      <>
        <SaveDot />
        <GuestAttentionBanner />
      </>,
    );
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent("Save failed");
    expect(screen.getByTestId("attention")).toHaveAttribute(
      "data-kind",
      "passive",
    );
    fireEvent.click(screen.getAllByRole("button", { name: /^Retry/ })[0]);
    expect(target).not.toHaveFocus();
    target.remove();
    offlineStore.loadHostCommandCount.mockResolvedValue(0);
    openDetails();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await settle();
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
    expect(
      screen.queryByRole("region", { name: /Needs attention/ }),
    ).not.toBeInTheDocument();
  });

  it("reveals dismissed History as inspect-only and keeps its queue reservation", async () => {
    const history = offlineConflict({
      kind: "unknown",
      reason: "Undo may have been applied.",
      recovery: "inspect-history",
      command: { command_id: "undo-1", type: "UndoHistory" },
    });
    offlineStore.loadHostCommandCount.mockResolvedValue(1);
    offlineStore.loadHostConflicts.mockResolvedValue([history]);
    offlineStore.dismissHostConflicts.mockResolvedValue({
      pending: 1,
      conflicts: [{ ...history, dismissed: true }],
    });
    const tree = (
      <>
        <SaveDot />
        <GuestAttentionBanner />
      </>
    );
    const rendered = render(tree);
    await settle();

    fireEvent.click(getActionButton("Dismiss all"));
    await settle();
    expect(
      screen.getByRole("region", { name: /Needs attention/ }),
    ).toHaveAccessibleName(/1 pending/);
    rendered.unmount();
    offlineStore.loadHostConflicts.mockResolvedValue([
      { ...history, dismissed: true },
    ]);
    render(tree);
    await settle();
    expect(
      screen.getByRole("region", { name: /Needs attention/ }),
    ).toHaveAccessibleName(/1 pending/);
    fireEvent.click(
      screen.getByRole("button", {
        name: /^Retry/,
      }),
    );

    const banner = screen.getByRole("region", { name: /Needs attention/ });
    await settle();
    expect(banner).toHaveFocus();
    expect(banner.querySelector("details")).toHaveAttribute("open");
    expect(getActionButton("Inspect History")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Dismiss all" }),
    ).not.toBeInTheDocument();
    fireEvent.click(getActionButton("Inspect History"));
    expect(useDawStore.getState().openSheet).toBe("history");
    expect(drain.requestHostDrain).not.toHaveBeenCalled();
  });

  it("focuses the Needs attention banner that a dismissed History outcome brings back", async () => {
    const history = offlineConflict({
      kind: "unknown",
      reason: "Undo may have been applied.",
      recovery: "inspect-history",
      command: { command_id: "undo-2", type: "UndoHistory" },
    });
    offlineStore.loadHostConflicts.mockResolvedValue([
      { ...history, dismissed: true },
    ]);
    render(
      <>
        <SaveDot />
        <GuestAttentionBanner />
      </>,
    );
    await settle();
    expect(
      screen.queryByRole("region", { name: /Needs attention/ }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Retry/ }));
    await settle();

    const banner = screen.getByRole("region", { name: /Needs attention/ });
    expect(banner).toHaveFocus();
    expect(banner.querySelector("details")).toHaveAttribute("open");
    expect(getActionButton("Inspect History")).toBeInTheDocument();
  });

  it("shows nothing to a share guest and reads no host queue", async () => {
    useDawStore.getState().hydrate("share:tok-1448", minimalProject(), null);
    render(<SaveDot />);
    await settle();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("group")).toBeNull();
    expect(offlineStore.loadHostCommandCount).not.toHaveBeenCalled();
  });
});
