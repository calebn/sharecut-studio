import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject, offlineConflict } from "../test/fixtures";
import { GuestAttentionBanner } from "./GuestAttentionBanner";

const offlineStore = vi.hoisted(() => ({
  clearConflicts: vi.fn(),
  clearHostConflicts: vi.fn(),
  loadConflicts: vi.fn(),
  loadCommandQueue: vi.fn(),
  loadHostCommandCount: vi.fn(),
  loadHostConflicts: vi.fn(),
}));

vi.mock("../state/offlineStore", () => offlineStore);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("GuestAttentionBanner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    for (const mock of Object.values(offlineStore)) {
      mock.mockReset();
    }
    offlineStore.clearConflicts.mockResolvedValue(undefined);
    offlineStore.clearHostConflicts.mockResolvedValue(undefined);
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

  it("shows retained-work status when the initial loads reject", async () => {
    offlineStore.loadHostConflicts.mockRejectedValue(new Error("boom"));
    offlineStore.loadHostCommandCount.mockRejectedValue(new Error("boom"));
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    render(<GuestAttentionBanner />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not read saved edits on this device. Your saved edits have been kept.",
    );
    expect(
      screen.queryByRole("button", { name: "Dismiss all" }),
    ).not.toBeInTheDocument();
    offlineStore.loadHostConflicts.mockResolvedValue([offlineConflict()]);
    offlineStore.loadHostCommandCount.mockResolvedValue(2);
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "2 pending, 1 conflict",
    );
    expect(
      screen.queryByText(/Could not read saved edits/),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Dismiss all" }),
    ).toBeInTheDocument();
  });

  it("shows unreadable guest queued edits without changing the guest pending count", async () => {
    offlineStore.loadCommandQueue.mockRejectedValue(
      new Error("Invalid saved command"),
    );
    useDawStore.getState().hydrate("share:tok-sample", minimalProject());
    render(<GuestAttentionBanner />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Your saved edits have been kept.",
    );
    expect(
      screen.queryByRole("button", { name: "Dismiss all" }),
    ).not.toBeInTheDocument();
    offlineStore.loadCommandQueue.mockResolvedValue([]);
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("retains the last verified count and conflicts until both reads succeed", async () => {
    offlineStore.loadHostConflicts.mockResolvedValue([offlineConflict()]);
    offlineStore.loadHostCommandCount.mockResolvedValue(2);
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    render(<GuestAttentionBanner />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "2 pending, 1 conflict",
    );
    offlineStore.loadHostConflicts.mockRejectedValue(
      new Error("Invalid saved conflict"),
    );
    offlineStore.loadHostCommandCount.mockResolvedValue(0);
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "2 pending, 1 conflict",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Your saved edits have been kept.",
    );
    expect(screen.getByRole("button", { name: "Dismiss all" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    useDawStore.getState().hydrate("/tmp/other.json", minimalProject());
    offlineStore.loadHostConflicts.mockResolvedValue([]);
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  describe.each([
    { namespace: "host", path: "/tmp/p.json", host: true },
    { namespace: "guest", path: "share:tok-sample", host: false },
  ])("$namespace refresh ownership", ({ path, host }) => {
    const read = () =>
      host ? offlineStore.loadHostConflicts : offlineStore.loadConflicts;
    const clear = () =>
      host ? offlineStore.clearHostConflicts : offlineStore.clearConflicts;
    const verified = offlineConflict({ reason: "Verified retained conflict" });
    const newer = offlineConflict({ reason: "Newer admitted conflict" });

    async function showVerified() {
      read().mockResolvedValue([verified]);
      offlineStore.loadHostCommandCount.mockResolvedValue(2);
      useDawStore.getState().hydrate(path, minimalProject());
      render(<GuestAttentionBanner />);
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Verified retained conflict",
      );
      expect(
        screen.getByRole("button", { name: "Dismiss all" }),
      ).toBeInTheDocument();
    }

    it("keeps a newer unreadable result after an older success", async () => {
      await showVerified();
      const old = deferred<ReturnType<typeof offlineConflict>[]>();
      read()
        .mockReturnValueOnce(old.promise)
        .mockRejectedValueOnce(new Error("unreadable"));
      offlineStore.loadHostCommandCount.mockResolvedValue(0);
      await act(() => vi.advanceTimersByTimeAsync(4000));
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Your saved edits have been kept.",
      );
      await act(async () => old.resolve([newer]));
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Verified retained conflict",
      );
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Your saved edits have been kept.",
      );
      if (host)
        expect(screen.getByRole("alert")).toHaveTextContent("2 pending");
      expect(
        screen.getByRole("button", { name: "Dismiss all" }),
      ).toHaveAttribute("aria-disabled", "true");
    });

    it("keeps a newer admission after an older failure", async () => {
      await showVerified();
      const old = deferred<ReturnType<typeof offlineConflict>[]>();
      read().mockReturnValueOnce(old.promise).mockResolvedValueOnce([newer]);
      await act(() => vi.advanceTimersByTimeAsync(4000));
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Newer admitted conflict",
      );
      await act(async () => old.reject(new Error("old unreadable")));
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Newer admitted conflict",
      );
      expect(
        screen.queryByText(/Could not read saved edits/),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Dismiss all" }),
      ).toBeInTheDocument();
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
        expect(screen.getByRole("alert")).toHaveTextContent(
          "Verified retained conflict",
        );
        if (host)
          expect(screen.getByRole("alert")).toHaveTextContent("2 pending");
        expect(
          screen.getByRole("button", { name: "Dismiss all" }),
        ).toHaveAttribute("aria-disabled", "true");
        expect(clear()).not.toHaveBeenCalled();
        await act(async () => {
          current.resolve([newer]);
          count.resolve(3);
          queue.resolve([]);
        });
        expect(
          screen.getByRole("button", { name: "Dismiss all" }),
        ).toBeInTheDocument();
      },
    );

    it.each(["queue", "conflicts"])(
      "preserves focused dismissal throughout a pending %s read",
      async (kind) => {
        await showVerified();
        const button = screen.getByRole("button", { name: "Dismiss all" });
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
        expect(screen.getByRole("button", { name: "Dismiss all" })).toBe(
          button,
        );
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
        expect(screen.getByRole("button", { name: "Dismiss all" })).toBe(
          button,
        );
        expect(button).toHaveFocus();
        expect((button as HTMLButtonElement).disabled).toBe(false);
        expect(button).not.toHaveAttribute("aria-disabled", "true");
      },
    );

    it("rejects a stale button click before the pending read renders", async () => {
      await showVerified();
      const button = screen.getByRole("button", { name: "Dismiss all" });
      const current = deferred<ReturnType<typeof offlineConflict>[]>();
      read().mockReturnValueOnce(current.promise);
      await act(async () => {
        vi.advanceTimersByTime(2000);
        fireEvent.click(button);
      });
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Verified retained conflict",
      );
      expect(clear()).not.toHaveBeenCalled();
      await act(async () => current.resolve([newer]));
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Newer admitted conflict",
      );
      expect(
        screen.getByRole("button", { name: "Dismiss all" }),
      ).toBeInTheDocument();
    });

    it("keeps a successful dismissal after an older read completes", async () => {
      await showVerified();
      const old = deferred<ReturnType<typeof offlineConflict>[]>();
      read().mockReturnValueOnce(old.promise).mockResolvedValueOnce([newer]);
      await act(() => vi.advanceTimersByTimeAsync(4000));
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Newer admitted conflict",
      );
      await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Dismiss all" })),
      );
      await act(async () => old.resolve([verified]));
      expect(
        screen.queryByText("Verified retained conflict"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText("Newer admitted conflict"),
      ).not.toBeInTheDocument();
      if (host)
        expect(screen.getByRole("alert")).toHaveTextContent("2 pending");
      else expect(screen.queryByRole("alert")).not.toBeInTheDocument();
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
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Newer admitted conflict",
      );
      await act(async () => old.resolve([verified]));
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Newer admitted conflict",
      );
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
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Verified retained conflict",
      );
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Your saved edits have been kept.",
      );
      await act(async () => retry.resolve([newer]));
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Newer admitted conflict",
      );
      expect(
        screen.queryByText(/Could not read saved edits/),
      ).not.toBeInTheDocument();
    });

    it("handles refused dismissal and keeps it withheld during a successful retry", async () => {
      await showVerified();
      clear().mockRejectedValueOnce(new Error("Invalid saved conflict"));
      await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Dismiss all" })),
      );
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Verified retained conflict",
      );
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Your saved edits have been kept.",
      );
      expect(
        screen.getByRole("button", { name: "Dismiss all" }),
      ).toHaveAttribute("aria-disabled", "true");
      await act(() => vi.advanceTimersByTimeAsync(2000));
      const dismiss = deferred<void>();
      clear().mockReturnValueOnce(dismiss.promise);
      await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Dismiss all" })),
      );
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Verified retained conflict",
      );
      expect(
        screen.getByRole("button", { name: "Dismiss all" }),
      ).toHaveAttribute("aria-disabled", "true");
      await act(() => vi.advanceTimersByTimeAsync(2000));
      expect(
        screen.getByRole("button", { name: "Dismiss all" }),
      ).toHaveAttribute("aria-disabled", "true");
      await act(async () => dismiss.resolve());
      expect(
        screen.queryByText("Verified retained conflict"),
      ).not.toBeInTheDocument();
      if (host)
        expect(screen.getByRole("alert")).toHaveTextContent("2 pending");
      else expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    it("ignores dismissal completion after a project switch", async () => {
      await showVerified();
      const dismiss = deferred<void>();
      clear().mockReturnValueOnce(dismiss.promise);
      await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Dismiss all" })),
      );
      read().mockResolvedValue([newer]);
      await act(async () =>
        useDawStore
          .getState()
          .hydrate(
            host ? "/tmp/new.json" : "share:new-token",
            minimalProject(),
          ),
      );
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Newer admitted conflict",
      );
      await act(async () => dismiss.resolve());
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Newer admitted conflict",
      );
    });
  });
});
