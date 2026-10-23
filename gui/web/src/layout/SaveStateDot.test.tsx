import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../commands/execute";
import { registerDawCommands } from "../commands/register";
import { recordVolatileOutcome } from "../services/offlineQueue/offlineAttention";
import { useDawStore } from "../state/dawStore";
import { beginDocumentSend } from "../state/documentSendOrder";
import { minimalProject, offlineConflict } from "../test/fixtures";
import { GuestAttentionBanner } from "./GuestAttentionBanner";
import { ATTENTION_BANNER_ID } from "./GuestAttentionBannerView";
import { SaveStateDot } from "./SaveStateDot";

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

vi.mock("../services/offlineQueue/offlineStore", () => offlineStore);
vi.mock("../services/offlineQueue/drainOfflineQueue", () => drain);

const PATH = "/tmp/save-state-1448.json";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
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

beforeEach(() => {
  clearRegisteredCommands();
  registerDawCommands();
});

afterEach(() => {
  clearRegisteredCommands();
});

describe("SaveStateDot", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const mock of [
      ...Object.values(offlineStore),
      ...Object.values(drain),
    ]) {
      mock.mockReset();
    }
    offlineStore.loadHostCommandCount.mockResolvedValue(0);
    offlineStore.loadHostConflicts.mockResolvedValue([]);
    offlineStore.dismissConflicts.mockResolvedValue({
      pending: 0,
      conflicts: [],
    });
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
  });

  it("shows nothing until the queue has been read, then Saved", async () => {
    const { container } = render(<SaveStateDot />);
    expect(container).toBeEmptyDOMElement();
    await settle();
    expect(
      screen.getByRole("img", { name: "Saved to project" }),
    ).toBeInTheDocument();
  });

  it("stays Saved when the only refusal is an Undo with nothing to undo", async () => {
    offlineStore.loadHostConflicts.mockResolvedValue([
      offlineConflict({
        command: { type: "UndoHistory" },
        reason: "Nothing to undo",
      }),
    ]);
    render(<SaveStateDot />);
    await settle();
    expect(
      screen.getByRole("img", { name: "Saved to project" }),
    ).toBeInTheDocument();
  });

  it("reads Saving while a send is in flight and Saved once it ends", async () => {
    render(<SaveStateDot />);
    await settle();
    let send!: ReturnType<typeof beginDocumentSend>;
    act(() => {
      send = beginDocumentSend(PATH, "cmd-1");
    });
    expect(
      screen.getByRole("img", { name: "Saving to project…" }),
    ).toBeInTheDocument();
    act(() => send.finish());
    await settle();
    expect(
      screen.getByRole("img", { name: "Saved to project" }),
    ).toBeInTheDocument();
  });

  it("never reads Saved between a failed send and the queue read that follows it", async () => {
    render(<SaveStateDot />);
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
    expect(
      screen.queryByRole("img", { name: "Saved to project" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("img", { name: "Saving to project…" }),
    ).toBeInTheDocument();
    await settle(500);
    expect(
      screen.queryByRole("img", { name: "Saved to project" }),
    ).not.toBeInTheDocument();
    await act(async () => {
      release(1);
    });
    await settle();
    expect(
      screen.getByRole("button", { name: "Not saved yet · 1 waiting to send" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("img", { name: "Saved to project" }),
    ).not.toBeInTheDocument();
  });

  it("ignores an older attention read that resolves after the post-send read", async () => {
    render(<SaveStateDot />);
    await settle();
    const older = deferred<{
      pending: number;
      conflicts: ReturnType<typeof offlineConflict>[];
    }>();
    offlineStore.loadHostAttention.mockReturnValueOnce(older.promise);
    await settle(2_000);

    let send!: ReturnType<typeof beginDocumentSend>;
    act(() => {
      send = beginDocumentSend(PATH, "cmd-out-of-order");
    });
    offlineStore.loadHostAttention.mockResolvedValueOnce({
      pending: 0,
      conflicts: [
        offlineConflict({
          kind: "unknown",
          reason: "Undo may have been applied",
          recovery: "inspect-history",
          command: { type: "UndoHistory" },
        }),
      ],
    });
    act(() => send.finish());
    await settle();
    expect(
      screen.getByRole("button", {
        name: "Outcome unknown · Undo may have been applied. Inspect History before trying again.",
      }),
    ).toBeInTheDocument();

    await act(async () => {
      older.resolve({ pending: 0, conflicts: [] });
    });
    expect(
      screen.getByRole("button", {
        name: "Outcome unknown · Undo may have been applied. Inspect History before trying again.",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("img", { name: "Saved to project" }),
    ).not.toBeInTheDocument();
  });

  it("reads the queue as soon as a send ends, not at the next poll", async () => {
    render(<SaveStateDot />);
    await settle();
    let send!: ReturnType<typeof beginDocumentSend>;
    act(() => {
      send = beginDocumentSend(PATH, "cmd-2");
    });
    offlineStore.loadHostCommandCount.mockResolvedValue(1);
    act(() => send.finish());
    await settle();
    expect(
      screen.getByRole("button", { name: "Not saved yet · 1 waiting to send" }),
    ).toBeInTheDocument();
  });

  it("moves focus to Needs attention when a waiting dot is pressed", async () => {
    offlineStore.loadHostCommandCount.mockResolvedValue(2);
    const banner = document.createElement("div");
    banner.id = ATTENTION_BANNER_ID;
    banner.tabIndex = -1;
    document.body.append(banner);
    render(<SaveStateDot />);
    await settle();
    const dot = screen.getByRole("button", {
      name: "Not saved yet · 2 waiting to send",
    });
    expect(dot).toHaveAttribute("data-save-state", "waiting");
    expect(dot).toHaveAttribute("title", "Not saved yet · 2 waiting to send");
    fireEvent.click(dot);
    expect(banner).toHaveFocus();
    expect(drain.requestHostDrain).not.toHaveBeenCalled();
    banner.remove();
  });

  it("stays saved on a refused edit and the Needs attention banner gives the reason", async () => {
    offlineStore.loadHostConflicts.mockResolvedValue([
      offlineConflict({ reason: "The clip moved" }),
    ]);
    render(
      <>
        <SaveStateDot />
        <GuestAttentionBanner />
      </>,
    );
    await settle();
    const dot = screen.getByRole("img", { name: "Saved to project" });
    expect(dot).toHaveAttribute("data-save-state", "saved");
    const banner = screen.getByRole("region", { name: /Needs attention/ });
    openDetails();
    expect(banner).toHaveTextContent("The clip moved");
  });

  it("stays saved when a newer volatile refusal replaces an unknown outcome", async () => {
    const path = "/tmp/save-state-newest-volatile.json";
    const earlier = offlineConflict({
      kind: "unknown",
      reason: "The earlier result was uncertain.",
      recovery: "retry-same-command",
      command: { command_id: "command-a" },
    });
    const later = offlineConflict({
      reason: "A separate command was refused.",
      command: { command_id: "command-b" },
    });
    const replacement = offlineConflict({
      reason: "The newer result was refused.",
      command: {
        command_id: earlier.command.command_id,
        client_id: earlier.command.client_id,
        client_seq: earlier.command.client_seq,
      },
    });
    offlineStore.loadHostConflicts.mockResolvedValue([earlier, later]);
    useDawStore.getState().hydrate(path, minimalProject(), null);
    render(<SaveStateDot />);
    await settle();

    act(() => recordVolatileOutcome(path, replacement));

    expect(
      screen.getByRole("img", { name: "Saved to project" }),
    ).toBeInTheDocument();
  });

  it("stays saved after a refusal is dismissed", async () => {
    const refused = offlineConflict({ reason: "The clip moved." });
    offlineStore.loadHostConflicts.mockResolvedValue([
      { ...refused, dismissed: true },
    ]);
    render(<SaveStateDot />);
    await settle();
    expect(
      screen.getByRole("img", { name: "Saved to project" }),
    ).toBeInTheDocument();
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
    const rendered = render(
      <>
        <SaveStateDot />
        <GuestAttentionBanner />
      </>,
    );
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
    render(
      <>
        <SaveStateDot />
        <GuestAttentionBanner />
      </>,
    );
    await settle();
    expect(
      screen.getByRole("region", { name: /Needs attention/ }),
    ).toHaveAccessibleName(/1 pending/);
    fireEvent.click(
      screen.getByRole("button", {
        name: /Outcome unknown .* Inspect History before trying again/,
      }),
    );

    const banner = screen.getByRole("region", { name: /Needs attention/ });
    expect(banner).toHaveFocus();
    expect(getActionButton("Inspect History")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Dismiss all" }),
    ).not.toBeInTheDocument();
    fireEvent.click(getActionButton("Inspect History"));
    expect(useDawStore.getState().moreDestination).toBe("history");
    expect(drain.requestHostDrain).not.toHaveBeenCalled();
  });

  it("publishes the exact pending count from dismissal while unrelated work remains", async () => {
    const refused = offlineConflict({ reason: "The clip moved." });
    offlineStore.loadHostCommandCount.mockResolvedValue(2);
    offlineStore.loadHostConflicts.mockResolvedValue([refused]);
    offlineStore.dismissHostConflicts.mockResolvedValue({
      pending: 1,
      conflicts: [{ ...refused, dismissed: true }],
    });
    render(
      <>
        <SaveStateDot />
        <GuestAttentionBanner />
      </>,
    );
    await settle();
    fireEvent.click(getActionButton("Dismiss all"));
    await settle();

    expect(
      screen.getByRole("region", { name: /Needs attention/ }),
    ).toHaveAccessibleName(/1 pending/);
    expect(
      screen.getByRole("button", { name: "Send now" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Dismiss all" }),
    ).not.toBeInTheDocument();
  });

  it("keeps a newer same-ID outcome when dismissal resolves", async () => {
    const racePath = "/tmp/save-state-dismiss-race.json";
    const old = offlineConflict({
      command: { command_id: "same-command", client_seq: 1 },
      reason: "Earlier refusal.",
    });
    const newer = offlineConflict({
      command: { command_id: "same-command", client_seq: 2 },
      reason: "Newer refusal.",
    });
    const dismissal = deferred<{
      pending: number;
      conflicts: ReturnType<typeof offlineConflict>[];
    }>();
    offlineStore.loadHostConflicts.mockResolvedValue([old]);
    offlineStore.dismissHostConflicts.mockReturnValueOnce(dismissal.promise);
    useDawStore.getState().hydrate(racePath, minimalProject(), null);
    render(
      <>
        <SaveStateDot />
        <GuestAttentionBanner />
      </>,
    );
    await settle();
    fireEvent.click(getActionButton("Dismiss all"));
    act(() => recordVolatileOutcome(racePath, newer));
    await act(async () => {
      dismissal.resolve({
        pending: 0,
        conflicts: [{ ...old, dismissed: true }],
      });
      await dismissal.promise;
    });

    expect(
      screen.getByRole("region", { name: /Needs attention/ }),
    ).toHaveTextContent("Newer refusal.");
    expect(
      screen.getByRole("region", { name: /Needs attention/ }),
    ).not.toHaveTextContent("Earlier refusal.");
    expect(screen.queryByText("0 pending")).not.toBeInTheDocument();
  });

  it("refreshes after activity begins and ends while dismissal is pending", async () => {
    const refused = offlineConflict({ reason: "The clip moved." });
    const dismissed = { ...refused, dismissed: true };
    const dismissal = deferred<{
      pending: number;
      conflicts: ReturnType<typeof offlineConflict>[];
    }>();
    offlineStore.loadHostAttention
      .mockResolvedValueOnce({ pending: 1, conflicts: [refused] })
      .mockResolvedValue({ pending: 0, conflicts: [dismissed] });
    offlineStore.dismissHostConflicts.mockReturnValueOnce(dismissal.promise);
    render(
      <>
        <SaveStateDot />
        <GuestAttentionBanner />
      </>,
    );
    await settle();
    fireEvent.click(getActionButton("Dismiss all"));
    let send!: ReturnType<typeof beginDocumentSend>;
    act(() => {
      send = beginDocumentSend(PATH, "dismissed-while-busy");
    });
    act(() => send.finish());
    expect(
      screen.getByRole("img", { name: "Saving to project…" }),
    ).toBeInTheDocument();

    await act(async () =>
      dismissal.resolve({ pending: 0, conflicts: [dismissed] }),
    );
    await settle();

    expect(offlineStore.loadHostAttention).toHaveBeenCalledTimes(2);
    expect(
      screen.getByRole("img", { name: "Saved to project" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("img", { name: "Saving to project…" }),
    ).not.toBeInTheDocument();
  });

  it("fails on unreadable saved edits and the banner offers Retry", async () => {
    offlineStore.loadHostCommandCount.mockRejectedValueOnce(new Error("idb"));
    render(
      <>
        <SaveStateDot />
        <GuestAttentionBanner />
      </>,
    );
    await settle();
    expect(
      screen.getByRole("img", {
        name: "Saved edits could not be read · Retry to read them",
      }),
    ).toHaveAttribute("data-save-state", "failed");
    offlineStore.loadHostCommandCount.mockResolvedValue(0);
    fireEvent.click(getActionButton("Retry"));
    await settle();
    expect(
      screen.getByRole("img", { name: "Saved to project" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: /Needs attention/ }),
    ).not.toBeInTheDocument();
  });

  it("shows nothing to a share guest and reads no host queue", async () => {
    useDawStore.getState().hydrate("share:tok-1448", minimalProject(), null);
    const { container } = render(<SaveStateDot />);
    await settle();
    expect(container).toBeEmptyDOMElement();
    expect(offlineStore.loadHostCommandCount).not.toHaveBeenCalled();
  });
});
