import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRegisteredCommands } from "../../commands/execute";
import { registerDawCommands } from "../../commands/register";
import {
  recordVolatileOutcome,
  volatileOutcomeFor,
} from "../../services/offlineQueue/offlineAttention";
import { useDawStore } from "../../state/dawStore";
import { SaveIndicator } from "../../system/SaveIndicator";
import { minimalProject, offlineConflict } from "../../test/fixtures";
import { TRANSCRIPT_REFINE_REFUSAL } from "../../utils/apiError";
import { GuestAttentionBanner } from "./GuestAttentionBanner";
import { useSaveIndicator } from "./useSaveIndicator";

const drain = vi.hoisted(() => ({ requestHostDrain: vi.fn() }));
vi.mock("../../services/offlineQueue/drainOfflineQueue", () => drain);

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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

type Dismissal = {
  pending: number;
  conflicts: ReturnType<typeof offlineConflict>[];
};

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

  it("uses the host path: loadHostConflicts + loadHostCommandCount, never loadConflicts", async () => {
    offlineStore.loadHostCommandCount.mockResolvedValue(1);
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    render(<GuestAttentionBanner />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(
      screen.getByRole("region", { name: /Needs attention/ }),
    ).toHaveAccessibleName(/1 pending/);
    expect(offlineStore.loadConflicts).not.toHaveBeenCalled();
    expect(offlineStore.loadHostConflicts).toHaveBeenCalledWith("/tmp/p.json");

    offlineStore.loadHostConflicts.mockResolvedValue([offlineConflict()]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await act(async () => {
      fireEvent.click(getActionButton("Dismiss all"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(offlineStore.dismissHostConflicts).toHaveBeenCalledWith(
      "/tmp/p.json",
      [expect.objectContaining({ command: expect.any(Object) })],
    );
    expect(
      screen.getByRole("region", { name: /Needs attention/ }),
    ).toHaveAccessibleName(/1 pending/);
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

  it("keeps a newer same-command outcome visible and fenced while dismissal is pending", async () => {
    const path = "/tmp/1478-dismiss-race.json";
    const observed = offlineConflict({
      command: { command_id: "same-command" },
      reason: "Earlier refusal.",
    });
    const newer = offlineConflict({
      command: { command_id: "same-command" },
      reason: "Newer refusal.",
    });
    const dismissal = deferred<Dismissal>();
    offlineStore.loadHostConflicts.mockResolvedValue([observed]);
    offlineStore.dismissHostConflicts.mockReturnValueOnce(dismissal.promise);
    useDawStore.getState().hydrate(path, minimalProject());
    render(<GuestAttentionBanner />);
    await act(() => vi.advanceTimersByTimeAsync(0));

    await act(async () => {
      fireEvent.click(getActionButton("Dismiss all"));
      recordVolatileOutcome(path, newer);
    });
    await act(async () =>
      dismissal.resolve({
        pending: 0,
        conflicts: [{ ...observed, dismissed: true }],
      }),
    );

    openDetails();
    expect(
      screen.getByRole("region", { name: /Needs attention/ }),
    ).toHaveTextContent("Newer refusal.");
    expect(volatileOutcomeFor(path, "same-command")).toMatchObject({
      reason: "Newer refusal.",
    });
    expect(volatileOutcomeFor(path, "same-command")).not.toHaveProperty(
      "dismissed",
      true,
    );
  });

  it.each([
    ["host", "/tmp/2182-host.json", true],
    ["guest", "share:tok-2182", false],
  ])(
    "offers the refine waiver to a %s only when it is the host",
    async (_who, path, offered) => {
      offlineStore.loadHostConflicts.mockResolvedValue([
        offlineConflict({ reason: TRANSCRIPT_REFINE_REFUSAL }),
      ]);
      offlineStore.loadConflicts.mockResolvedValue([
        offlineConflict({ reason: TRANSCRIPT_REFINE_REFUSAL }),
      ]);
      useDawStore.getState().hydrate(path, minimalProject());
      render(<GuestAttentionBanner />);
      await act(() => vi.advanceTimersByTimeAsync(0));
      openDetails();
      expect(
        screen.queryByRole("button", { name: "Waive with reason" }) !== null,
      ).toBe(offered);
    },
  );

  it("picks up a new count after the 2s poll", async () => {
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    render(<GuestAttentionBanner />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(
      screen.queryByRole("region", { name: /Needs attention/ }),
    ).not.toBeInTheDocument();
    offlineStore.loadHostCommandCount.mockResolvedValue(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(
      screen.getByRole("region", { name: /Needs attention/ }),
    ).toHaveAccessibleName(/3 pending/);
  });

  it("shows retained-work status when the initial loads reject", async () => {
    offlineStore.loadHostConflicts.mockRejectedValue(new Error("boom"));
    offlineStore.loadHostCommandCount.mockRejectedValue(new Error("boom"));
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    render(<GuestAttentionBanner />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    openDetails();
    expect(
      screen.getByRole("region", { name: /Needs attention/ }),
    ).toHaveTextContent(
      "Could not read saved edits on this device. Your saved edits have been kept.",
    );
    expect(
      screen.queryByRole("button", { name: "Dismiss all" }),
    ).not.toBeInTheDocument();
    offlineStore.loadHostConflicts.mockResolvedValue([offlineConflict()]);
    offlineStore.loadHostCommandCount.mockResolvedValue(2);
    await act(() => vi.advanceTimersByTimeAsync(2000));
    openDetails();
    expect(
      screen.getByRole("region", { name: /Needs attention/ }),
    ).toHaveAccessibleName(/2 pending, 1 conflict/);
    expect(
      screen.queryByText(/Could not read saved edits/),
    ).not.toBeInTheDocument();
    expect(getActionButton("Dismiss all")).toBeInTheDocument();
  });

  it.each(["edit", "review", "deliver"] as const)(
    "opens the History sheet over Edit from %s",
    async (from) => {
      offlineStore.loadHostConflicts.mockResolvedValue([
        offlineConflict({
          kind: "unknown",
          reason: "Undo or Redo may have been applied.",
          recovery: "inspect-history",
          command: { type: "UndoHistory" },
        }),
      ]);
      useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
      useDawStore.getState().openStage(from);
      render(<GuestAttentionBanner />);
      await act(() => vi.advanceTimersByTimeAsync(0));
      fireEvent.click(getActionButton("Inspect History"));
      const state = useDawStore.getState();
      expect(state.stage).toBe("edit");
      expect(state.openSheet).toBe("history");
    },
  );

  it("opens History for an Undo outcome whose result is unknown", async () => {
    const conflict = offlineConflict({
      kind: "unknown",
      reason: "Undo or Redo may have been applied.",
      recovery: "inspect-history",
      command: { type: "UndoHistory" },
    });
    offlineStore.loadHostConflicts.mockResolvedValue([conflict]);
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    render(<GuestAttentionBanner />);
    await act(() => vi.advanceTimersByTimeAsync(0));

    fireEvent.click(getActionButton("Inspect History"));
    expect(useDawStore.getState().openSheet).toBe("history");
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

  it("retains the last verified count and conflicts until both reads succeed", async () => {
    offlineStore.loadHostConflicts.mockResolvedValue([offlineConflict()]);
    offlineStore.loadHostCommandCount.mockResolvedValue(2);
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    render(<GuestAttentionBanner />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    openDetails();
    expect(
      screen.getByRole("region", { name: /Needs attention/ }),
    ).toHaveAccessibleName(/2 pending, 1 conflict/);
    offlineStore.loadHostConflicts.mockRejectedValue(
      new Error("Invalid saved conflict"),
    );
    offlineStore.loadHostCommandCount.mockResolvedValue(0);
    await act(() => vi.advanceTimersByTimeAsync(2000));
    openDetails();
    expect(
      screen.getByRole("region", { name: /Needs attention/ }),
    ).toHaveAccessibleName(/2 pending, 1 conflict/);
    openDetails();
    expect(
      screen.getByRole("region", { name: /Needs attention/ }),
    ).toHaveTextContent("Your saved edits have been kept.");
    expect(getActionButton("Dismiss all")).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    useDawStore.getState().hydrate("/tmp/other.json", minimalProject());
    offlineStore.loadHostConflicts.mockResolvedValue([]);
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(
      screen.queryByRole("region", { name: /Needs attention/ }),
    ).not.toBeInTheDocument();
  });
  describe.each([
    { namespace: "host", path: "/tmp/p.json", host: true },
    { namespace: "guest", path: "share:tok-sample", host: false },
  ])("$namespace refresh ownership", ({ path, host }) => {
    const read = () =>
      host ? offlineStore.loadHostConflicts : offlineStore.loadConflicts;
    const clear = () =>
      host ? offlineStore.dismissHostConflicts : offlineStore.dismissConflicts;
    const verified = offlineConflict({ reason: "Verified retained conflict" });
    const newer = offlineConflict({ reason: "Newer admitted conflict" });

    async function showVerified() {
      read().mockResolvedValue([verified]);
      offlineStore.loadHostCommandCount.mockResolvedValue(2);
      useDawStore.getState().hydrate(path, minimalProject());
      render(<GuestAttentionBanner />);
      await act(() => vi.advanceTimersByTimeAsync(0));
      openDetails();
      expect(
        screen.getByRole("region", { name: /Needs attention/ }),
      ).toHaveTextContent("Verified retained conflict");
      expect(getActionButton("Dismiss all")).toBeInTheDocument();
    }

    it("keeps a newer unreadable result after an older success", async () => {
      await showVerified();
      const old = deferred<ReturnType<typeof offlineConflict>[]>();
      read()
        .mockReturnValueOnce(old.promise)
        .mockRejectedValueOnce(new Error("unreadable"));
      offlineStore.loadHostCommandCount.mockResolvedValue(0);
      await act(() => vi.advanceTimersByTimeAsync(4000));
      openDetails();
      expect(
        screen.getByRole("region", { name: /Needs attention/ }),
      ).toHaveTextContent("Your saved edits have been kept.");
      await act(async () => old.resolve([newer]));
      openDetails();
      expect(
        screen.getByRole("region", { name: /Needs attention/ }),
      ).toHaveTextContent("Verified retained conflict");
      openDetails();
      expect(
        screen.getByRole("region", { name: /Needs attention/ }),
      ).toHaveTextContent("Your saved edits have been kept.");
      if (host)
        expect(
          screen.getByRole("region", { name: /Needs attention/ }),
        ).toHaveAccessibleName(/2 pending/);
      expect(getActionButton("Dismiss all")).toHaveAttribute(
        "aria-disabled",
        "true",
      );
    });

    it("keeps a newer admission after an older failure", async () => {
      await showVerified();
      const old = deferred<ReturnType<typeof offlineConflict>[]>();
      read().mockReturnValueOnce(old.promise).mockResolvedValueOnce([newer]);
      await act(() => vi.advanceTimersByTimeAsync(4000));
      openDetails();
      expect(
        screen.getByRole("region", { name: /Needs attention/ }),
      ).toHaveTextContent("Newer admitted conflict");
      await act(async () => old.reject(new Error("old unreadable")));
      openDetails();
      expect(
        screen.getByRole("region", { name: /Needs attention/ }),
      ).toHaveTextContent("Newer admitted conflict");
      expect(
        screen.queryByText(/Could not read saved edits/),
      ).not.toBeInTheDocument();
      expect(getActionButton("Dismiss all")).toBeInTheDocument();
    });

    it.each(["queue", "conflicts"])(
      "withholds dismissal throughout a pending %s read",
      async (kind) => {
        await showVerified();
        const current = deferred<ReturnType<typeof offlineConflict>[]>();
        const count = deferred<number>();
        const queue = deferred<[]>();
        if (kind === "conflicts") read().mockReturnValueOnce(current.promise);
        else if (host)
          offlineStore.loadHostCommandCount.mockReturnValueOnce(count.promise);
        else offlineStore.loadCommandQueue.mockReturnValueOnce(queue.promise);
        await act(() => vi.advanceTimersByTimeAsync(2000));
        openDetails();
        expect(
          screen.getByRole("region", { name: /Needs attention/ }),
        ).toHaveTextContent("Verified retained conflict");
        if (host)
          expect(
            screen.getByRole("region", { name: /Needs attention/ }),
          ).toHaveAccessibleName(/2 pending/);
        expect(getActionButton("Dismiss all")).toHaveAttribute(
          "aria-disabled",
          "true",
        );
        expect(clear()).not.toHaveBeenCalled();
        await act(async () => {
          current.resolve([newer]);
          count.resolve(3);
          queue.resolve([]);
        });
        expect(getActionButton("Dismiss all")).toBeInTheDocument();
      },
    );

    it.each(["queue", "conflicts"])(
      "preserves focused dismissal throughout a pending %s read",
      async (kind) => {
        await showVerified();
        const button = getActionButton("Dismiss all");
        button.focus();
        expect(button).toHaveFocus();
        const conflicts = deferred<ReturnType<typeof offlineConflict>[]>();
        const count = deferred<number>();
        const queue = deferred<[]>();
        if (kind === "conflicts") read().mockReturnValueOnce(conflicts.promise);
        else if (host)
          offlineStore.loadHostCommandCount.mockReturnValueOnce(count.promise);
        else offlineStore.loadCommandQueue.mockReturnValueOnce(queue.promise);

        await act(() => vi.advanceTimersByTimeAsync(2000));
        await act(async () => fireEvent.click(button));
        expect(clear()).not.toHaveBeenCalled();
        expect(button).toBeInTheDocument();
        expect(getActionButton("Dismiss all")).toBe(button);
        expect(button).toHaveFocus();
        expect(
          (button as HTMLButtonElement).disabled ||
            button.getAttribute("aria-disabled") === "true",
        ).toBe(true);
        expect(button).toHaveAccessibleDescription(
          "Checking saved edits. Dismissal is unavailable.",
        );

        await act(async () => {
          conflicts.resolve([newer]);
          count.resolve(3);
          queue.resolve([]);
        });
        expect(getActionButton("Dismiss all")).toBe(button);
        expect(button).toHaveFocus();
        expect((button as HTMLButtonElement).disabled).toBe(false);
        expect(button).not.toHaveAttribute("aria-disabled", "true");
      },
    );

    it("rejects a stale button click before the pending read renders", async () => {
      await showVerified();
      const button = getActionButton("Dismiss all");
      const current = deferred<ReturnType<typeof offlineConflict>[]>();
      read().mockReturnValueOnce(current.promise);
      await act(async () => {
        vi.advanceTimersByTime(2000);
        fireEvent.click(button);
      });
      openDetails();
      expect(
        screen.getByRole("region", { name: /Needs attention/ }),
      ).toHaveTextContent("Verified retained conflict");
      expect(clear()).not.toHaveBeenCalled();
      await act(async () => current.resolve([newer]));
      openDetails();
      expect(
        screen.getByRole("region", { name: /Needs attention/ }),
      ).toHaveTextContent("Newer admitted conflict");
      expect(getActionButton("Dismiss all")).toBeInTheDocument();
    });

    it("keeps a successful dismissal after an older read completes", async () => {
      await showVerified();
      const old = deferred<ReturnType<typeof offlineConflict>[]>();
      read().mockReturnValueOnce(old.promise).mockResolvedValueOnce([newer]);
      await act(() => vi.advanceTimersByTimeAsync(4000));
      openDetails();
      expect(
        screen.getByRole("region", { name: /Needs attention/ }),
      ).toHaveTextContent("Newer admitted conflict");
      await act(async () => fireEvent.click(getActionButton("Dismiss all")));
      await act(async () => old.resolve([verified]));
      expect(
        screen.queryByText("Verified retained conflict"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText("Newer admitted conflict"),
      ).not.toBeInTheDocument();
      if (host) {
        expect(
          screen.getByRole("region", { name: /Needs attention/ }),
        ).toHaveAccessibleName(/2 pending/);
      } else
        expect(
          screen.queryByRole("region", { name: /Needs attention/ }),
        ).not.toBeInTheDocument();
    });

    it("ignores a read result from the previous project", async () => {
      await showVerified();
      const old = deferred<ReturnType<typeof offlineConflict>[]>();
      read().mockReturnValueOnce(old.promise).mockResolvedValue([newer]);
      await act(() => vi.advanceTimersByTimeAsync(2000));
      await act(async () =>
        useDawStore
          .getState()
          .hydrate(
            host ? "/tmp/new.json" : "share:new-token",
            minimalProject(),
          ),
      );
      openDetails();
      expect(
        screen.getByRole("region", { name: /Needs attention/ }),
      ).toHaveTextContent("Newer admitted conflict");
      await act(async () => old.resolve([verified]));
      openDetails();
      expect(
        screen.getByRole("region", { name: /Needs attention/ }),
      ).toHaveTextContent("Newer admitted conflict");
      expect(
        screen.queryByText("Verified retained conflict"),
      ).not.toBeInTheDocument();
    });

    it("retains its warning during a pending retry", async () => {
      await showVerified();
      read().mockRejectedValueOnce(new Error("unreadable"));
      await act(() => vi.advanceTimersByTimeAsync(2000));
      const retry = deferred<ReturnType<typeof offlineConflict>[]>();
      read().mockReturnValueOnce(retry.promise);
      await act(() => vi.advanceTimersByTimeAsync(2000));
      openDetails();
      expect(
        screen.getByRole("region", { name: /Needs attention/ }),
      ).toHaveTextContent("Verified retained conflict");
      openDetails();
      expect(
        screen.getByRole("region", { name: /Needs attention/ }),
      ).toHaveTextContent("Your saved edits have been kept.");
      await act(async () => retry.resolve([newer]));
      openDetails();
      expect(
        screen.getByRole("region", { name: /Needs attention/ }),
      ).toHaveTextContent("Newer admitted conflict");
      expect(
        screen.queryByText(/Could not read saved edits/),
      ).not.toBeInTheDocument();
    });

    it("handles refused dismissal and keeps it withheld during a successful retry", async () => {
      await showVerified();
      clear().mockRejectedValueOnce(new Error("Invalid saved conflict"));
      await act(async () => fireEvent.click(getActionButton("Dismiss all")));
      openDetails();
      expect(
        screen.getByRole("region", { name: /Needs attention/ }),
      ).toHaveTextContent("Verified retained conflict");
      openDetails();
      expect(
        screen.getByRole("region", { name: /Needs attention/ }),
      ).toHaveTextContent(
        "Dismissal failed. Your saved outcomes have been kept.",
      );
      expect(getActionButton("Dismiss all")).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      await act(() => vi.advanceTimersByTimeAsync(2000));
      const dismiss = deferred<Dismissal>();
      clear().mockReturnValueOnce(dismiss.promise);
      await act(async () => fireEvent.click(getActionButton("Dismiss all")));
      openDetails();
      expect(
        screen.getByRole("region", { name: /Needs attention/ }),
      ).toHaveTextContent("Verified retained conflict");
      expect(getActionButton("Dismiss all")).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      await act(() => vi.advanceTimersByTimeAsync(2000));
      expect(getActionButton("Dismiss all")).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      await act(async () =>
        dismiss.resolve({
          pending: host ? 2 : 0,
          conflicts: [{ ...verified, dismissed: true }],
        }),
      );
      expect(
        screen.queryByText("Verified retained conflict"),
      ).not.toBeInTheDocument();
      if (host) {
        expect(
          screen.getByRole("region", { name: /Needs attention/ }),
        ).toHaveAccessibleName(/2 pending/);
      } else
        expect(
          screen.queryByRole("region", { name: /Needs attention/ }),
        ).not.toBeInTheDocument();
    });

    it("ignores dismissal completion after a project switch", async () => {
      await showVerified();
      const dismiss = deferred<Dismissal>();
      clear().mockReturnValueOnce(dismiss.promise);
      await act(async () => fireEvent.click(getActionButton("Dismiss all")));
      read().mockResolvedValue([newer]);
      await act(async () =>
        useDawStore
          .getState()
          .hydrate(
            host ? "/tmp/new.json" : "share:new-token",
            minimalProject(),
          ),
      );
      openDetails();
      expect(
        screen.getByRole("region", { name: /Needs attention/ }),
      ).toHaveTextContent("Newer admitted conflict");
      await act(async () =>
        dismiss.resolve({ pending: host ? 2 : 0, conflicts: [newer] }),
      );
      openDetails();
      expect(
        screen.getByRole("region", { name: /Needs attention/ }),
      ).toHaveTextContent("Newer admitted conflict");
    });
  });

  it("converges when dismissal rejects after a send ended during dismissal", async () => {
    const path = "/tmp/1540-dismiss-send-end.json";
    const verified = offlineConflict({ reason: "Verified retained conflict" });
    offlineStore.loadHostConflicts.mockResolvedValue([verified]);
    offlineStore.loadHostCommandCount.mockResolvedValue(2);
    const dismissal = deferred<Dismissal>();
    offlineStore.dismissHostConflicts.mockReturnValueOnce(dismissal.promise);
    useDawStore.getState().hydrate(path, minimalProject());
    const { beginDocumentSend } = await import("../../state/documentSendOrder");
    function SaveDot() {
      const props = useSaveIndicator();
      return props ? <SaveIndicator {...props} /> : null;
    }
    render(
      <>
        <SaveDot />
        <GuestAttentionBanner />
      </>,
    );
    await act(() => vi.advanceTimersByTimeAsync(0));

    await act(async () => fireEvent.click(getActionButton("Dismiss all")));
    act(() => {
      const send = beginDocumentSend(path, "during-dismiss");
      send.finish();
    });
    offlineStore.loadHostCommandCount.mockResolvedValue(0);
    offlineStore.loadHostConflicts.mockResolvedValue([]);

    await act(async () => {
      dismissal.reject(new Error("dismiss refused"));
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.getByRole("status")).toHaveTextContent("Saved");
    expect(
      screen.queryByRole("region", { name: /Needs attention/ }),
    ).not.toBeInTheDocument();
    expect(offlineStore.loadHostCommandCount.mock.calls.length).toBeGreaterThan(
      1,
    );
  });

  it("Send now replays the host queue; a share guest is not offered it", async () => {
    offlineStore.loadHostCommandCount.mockResolvedValue(1);
    drain.requestHostDrain.mockResolvedValue(undefined);
    useDawStore.getState().hydrate("/tmp/p-1448.json", minimalProject());
    const { unmount } = render(<GuestAttentionBanner />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    fireEvent.click(getActionButton("Send now"));
    expect(drain.requestHostDrain).toHaveBeenCalledWith("/tmp/p-1448.json");
    unmount();

    offlineStore.loadConflicts.mockResolvedValue([offlineConflict()]);
    useDawStore.getState().hydrate("share:tok-1448", minimalProject());
    render(<GuestAttentionBanner />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(
      screen.queryByRole("button", { name: "Send now" }),
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
