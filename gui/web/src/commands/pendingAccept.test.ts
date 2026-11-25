import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { acceptPending } from "./pendingAccept";

vi.mock("../api", () => ({
  applySuggestedActions: vi.fn(),
  approveEdits: vi.fn(),
}));

describe("acceptPending", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.applySuggestedActions).mockResolvedValue({
      queued: false,
      summary: "Done",
      historyHead: "h",
    } as never);
    vi.mocked(api.approveEdits).mockResolvedValue({
      queued: false,
      count: 1,
      historyHead: "h",
    } as never);
  });

  it.each([
    ["leave", "remove", 1],
    ["leave", "split", 1],
    ["shorten", "remove", 1],
    ["cut", "remove", 0],
    [null, "remove", 0],
  ] as const)(
    "a %s suggestion on a %s applies it %i time(s)",
    async (suggested_action, type, applied) => {
      await acceptPending("/tmp/p", {
        id: "e1",
        type,
        suggested_action,
      } as never);
      expect(api.applySuggestedActions).toHaveBeenCalledTimes(applied);
      expect(api.approveEdits).toHaveBeenCalledTimes(1 - applied);
    },
  );

  describe("the leave route", () => {
    const leave = {
      id: "e1",
      track_id: "host",
      type: "remove",
      suggested_action: "leave",
      applied: false,
    } as never;

    const open = () => {
      useDawStore
        .getState()
        .hydrate("/tmp/p", minimalProject({ pending_edits: [leave] }));
      useDawStore
        .getState()
        .setSelection({ kind: "pending", id: "e1", trackId: "host" });
      useDawStore.setState({ statusAnnouncement: "", feedbackToast: null });
    };
    const toast = () => useDawStore.getState().feedbackToast;

    it("announces the summary with this action's Undo and clears the selection", async () => {
      open();
      vi.mocked(api.applySuggestedActions).mockResolvedValue({
        queued: false,
        summary: "Applied 1 leave.",
        historyHead: "h-1",
        appliedCount: 1,
      } as never);
      await acceptPending("/tmp/p", leave);
      expect(toast()?.message).toBe("Applied 1 leave.");
      expect(toast()?.undo).toBe("h-1");
      expect(useDawStore.getState().selection).toBeNull();
    });

    it("does not announce Applied nothing or offer an Undo when nothing was applied", async () => {
      open();
      vi.mocked(api.applySuggestedActions).mockResolvedValue({
        queued: false,
        summary: "Applied nothing.",
        historyHead: "someone-elses-head",
        appliedCount: 0,
      } as never);
      await acceptPending("/tmp/p", leave);
      expect(toast()?.message).not.toMatch(/Applied nothing/);
      expect(toast()?.undo ?? null).toBeNull();
      expect(toast()?.message).toBeTruthy();
    });

    it("keeps the selection when nothing was applied and the suggestion is still pending", async () => {
      open();
      vi.mocked(api.applySuggestedActions).mockResolvedValue({
        queued: false,
        summary: "Applied nothing; 1 still pending.",
        historyHead: null,
        appliedCount: 0,
      } as never);
      await acceptPending("/tmp/p", leave);
      expect(useDawStore.getState().selection).not.toBeNull();
    });

    it("says nothing when the project changes before the reply", async () => {
      open();
      let finish: (value: unknown) => void = () => {};
      vi.mocked(api.applySuggestedActions).mockReturnValue(
        new Promise((resolve) => {
          finish = (value) => resolve(value as never);
        }),
      );
      const pending = acceptPending("/tmp/p", leave);
      useDawStore
        .getState()
        .hydrate("/tmp/other", minimalProject({ pending_edits: [] }));
      finish({
        queued: false,
        summary: "Applied 1 leave.",
        historyHead: "h-old",
        appliedCount: 1,
      });
      await pending;
      expect(toast()).toBeNull();
    });

    it("says nothing when the same path is reloaded (new epoch) before the reply", async () => {
      open();
      let finish: (value: unknown) => void = () => {};
      vi.mocked(api.applySuggestedActions).mockReturnValue(
        new Promise((resolve) => {
          finish = (value) => resolve(value as never);
        }),
      );
      const pending = acceptPending("/tmp/p", leave);
      useDawStore.setState((s) => ({ projectEpoch: s.projectEpoch + 1 }));
      finish({
        queued: false,
        summary: "Applied 1 leave.",
        historyHead: "h-old",
        appliedCount: 1,
      });
      await pending;
      expect(toast()).toBeNull();
    });

    it("announces but keeps another selection made before the reply", async () => {
      open();
      let finish: (value: unknown) => void = () => {};
      vi.mocked(api.applySuggestedActions).mockReturnValue(
        new Promise((resolve) => {
          finish = (value) => resolve(value as never);
        }),
      );
      const pending = acceptPending("/tmp/p", leave);
      const other = { kind: "pending", id: "e2", trackId: "host" } as const;
      useDawStore.getState().setSelection(other);
      finish({
        queued: false,
        summary: "Applied 1 leave.",
        historyHead: "h-1",
        appliedCount: 1,
      });
      await pending;
      expect(toast()?.message).toBe("Applied 1 leave.");
      expect(useDawStore.getState().selection).toMatchObject({ id: "e2" });
    });

    it("lets a refused leave reject to the caller", async () => {
      open();
      vi.mocked(api.applySuggestedActions).mockRejectedValue(
        new Error("Refused"),
      );
      await expect(acceptPending("/tmp/p", leave)).rejects.toThrow("Refused");
      expect(toast()).toBeNull();
    });
  });
});
