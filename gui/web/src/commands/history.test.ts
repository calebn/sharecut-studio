import { beforeEach, describe, expect, it, vi } from "vitest";
import { redoHistory, undoHistory } from "../api";
import { useDawStore } from "../state/dawStore";
import {
  beginHostSend,
  HOST_SEND_WAIT_MS,
  noteSaveLanded,
  trackEditSave,
} from "../state/hostSendOrder";
import { minimalProject } from "../test/fixtures";
import type { HistoryEntryId } from "../types/project";
import { ApiError } from "../utils/apiError";
import { clearRegisteredCommands, execute } from "./execute";
import { _resetHistoryMovesForTests, registerHistoryCommands } from "./history";
import { flushPendingMix } from "./trackMix";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  undoHistory: vi.fn(async () => null),
  redoHistory: vi.fn(async () => null),
}));

vi.mock("./trackMix", () => ({ flushPendingMix: vi.fn(async () => {}) }));

function showHead(headId: string) {
  const project = useDawStore.getState().project ?? minimalProject();
  useDawStore.setState({
    project: {
      ...project,
      history: {
        ...project.history,
        head_id: headId as HistoryEntryId,
        can_undo: true,
        can_redo: true,
      },
    },
  });
}

describe("history.undo / history.redo (Mod+Z, Mod+Shift+Z)", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerHistoryCommands();
    _resetHistoryMovesForTests();
    vi.mocked(undoHistory).mockReset();
    vi.mocked(redoHistory).mockReset();
    useDawStore.setState({
      projectPath: "/tmp/ep",
      project: minimalProject(),
      feedbackToast: null,
      statusAnnouncement: "",
    });
    showHead("seen-by-tab");
  });

  it("sends the head this tab shows after its pending mix edits are saved", async () => {
    vi.mocked(flushPendingMix).mockImplementationOnce(async () => {
      showHead("after-fader-save");
    });
    expect(await execute("history.undo")).toEqual({ status: "ok" });
    expect(undoHistory).toHaveBeenCalledWith("/tmp/ep", {
      expectedHeadId: "after-fader-save",
    });
  });

  it("refuses a stale Mod+Z and says nothing was undone", async () => {
    vi.mocked(undoHistory).mockRejectedValueOnce(
      new ApiError("Did not undo", "history_stale", 409),
    );
    const refused =
      "Can't undo: the project changed since. Nothing was undone.";
    expect(await execute("history.undo")).toEqual({
      status: "disabled",
      reason: refused,
      announced: true,
    });
    expect(useDawStore.getState().statusAnnouncement).toBe(refused);
    expect(useDawStore.getState().feedbackToast).toMatchObject({
      message: refused,
      undo: null,
    });
  });

  it("guards redo the same way", async () => {
    vi.mocked(redoHistory).mockRejectedValueOnce(
      new ApiError("Did not redo", "history_stale", 409),
    );
    expect(await execute("history.redo")).toEqual({
      status: "disabled",
      reason: "Can't redo: the project changed since. Nothing was redone.",
      announced: true,
    });
    expect(redoHistory).toHaveBeenCalledWith("/tmp/ep", {
      expectedHeadId: "seen-by-tab",
    });
  });

  it("passes any other failure through", async () => {
    vi.mocked(undoHistory).mockRejectedValueOnce(
      new ApiError("Nothing to undo", null, 400),
    );
    await expect(execute("history.undo")).rejects.toThrow("Nothing to undo");
  });

  describe("this tab's own moves run one after another", () => {
    const head = (id: string) => id as HistoryEntryId;

    /** An undo reply the test releases by hand, landing on `landed`. */
    function heldReply() {
      let release!: (landed: HistoryEntryId | null) => void;
      const reply = new Promise<HistoryEntryId | null>((resolve) => {
        release = resolve;
      });
      return { reply, release };
    }

    it("sends a second fast Mod+Z after the first reply, expecting where it landed", async () => {
      const first = heldReply();
      vi.mocked(undoHistory)
        .mockImplementationOnce(() => first.reply)
        .mockResolvedValueOnce(head("after-second"));

      const one = execute("history.undo");
      const two = execute("history.undo");
      await vi.waitFor(() => expect(undoHistory).toHaveBeenCalledTimes(1));
      await Promise.resolve();
      expect(undoHistory).toHaveBeenCalledTimes(1);

      first.release(head("after-first"));
      expect(await one).toEqual({ status: "ok" });
      expect(await two).toEqual({ status: "ok" });
      expect(vi.mocked(undoHistory).mock.calls).toEqual([
        ["/tmp/ep", { expectedHeadId: "seen-by-tab" }],
        ["/tmp/ep", { expectedHeadId: "after-first" }],
      ]);
    });

    it("chains N fast presses, undo and redo alike, through each reply's head", async () => {
      let n = 0;
      const land = async () => head(`landed-${++n}`);
      vi.mocked(undoHistory).mockImplementation(land);
      vi.mocked(redoHistory).mockImplementation(land);

      const results = await Promise.all([
        execute("history.undo"),
        execute("history.undo"),
        execute("history.undo"),
        execute("history.redo"),
      ]);

      expect(results.every((r) => r.status === "ok")).toBe(true);
      expect(vi.mocked(undoHistory).mock.calls.map((c) => c[1])).toEqual([
        { expectedHeadId: "seen-by-tab" },
        { expectedHeadId: "landed-1" },
        { expectedHeadId: "landed-2" },
      ]);
      expect(redoHistory).toHaveBeenCalledWith("/tmp/ep", {
        expectedHeadId: "landed-3",
      });
    });

    it("expects where its own move landed while the tab still shows where it started", async () => {
      vi.mocked(undoHistory)
        .mockResolvedValueOnce(head("own-landing"))
        .mockResolvedValueOnce(null);

      await execute("history.undo");
      await execute("history.undo");

      expect(vi.mocked(undoHistory).mock.calls[1]?.[1]).toEqual({
        expectedHeadId: "own-landing",
      });
    });

    it("expects the head the tab shows once someone else's edit arrives", async () => {
      vi.mocked(undoHistory)
        .mockResolvedValueOnce(head("own-landing"))
        .mockResolvedValueOnce(null);

      await execute("history.undo");
      showHead("peer-edit");
      await execute("history.undo");

      expect(vi.mocked(undoHistory).mock.calls[1]?.[1]).toEqual({
        expectedHeadId: "peer-edit",
      });
    });

    it("does not adopt a peer edit that arrives while a press waits its turn", async () => {
      const first = heldReply();
      vi.mocked(undoHistory)
        .mockImplementationOnce(() => first.reply)
        .mockResolvedValueOnce(null);

      const one = execute("history.undo");
      const two = execute("history.undo");
      await vi.waitFor(() => expect(undoHistory).toHaveBeenCalledTimes(1));
      showHead("peer-edit-the-user-never-saw");
      first.release(head("after-first"));
      await Promise.all([one, two]);

      expect(vi.mocked(undoHistory).mock.calls[1]?.[1]).toEqual({
        expectedHeadId: "after-first",
      });
    });

    it("refuses a press queued behind a refused move the same way", async () => {
      const stale = new ApiError("Did not undo", "history_stale", 409);
      vi.mocked(undoHistory)
        .mockRejectedValueOnce(stale)
        .mockRejectedValueOnce(stale);

      const [one, two] = await Promise.all([
        execute("history.undo"),
        execute("history.undo"),
      ]);

      expect(one.status).toBe("disabled");
      expect(two.status).toBe("disabled");
      expect(vi.mocked(undoHistory).mock.calls.map((c) => c[1])).toEqual([
        { expectedHeadId: "seen-by-tab" },
        { expectedHeadId: "seen-by-tab" },
      ]);
    });

    it("keeps a toast's own entry even when it waits behind a Mod+Z", async () => {
      vi.mocked(undoHistory).mockResolvedValueOnce(head("after-modz"));

      await Promise.all([
        execute("history.undo"),
        execute("history.undo", { expectedHeadId: "toast-entry" }),
      ]);

      expect(vi.mocked(undoHistory).mock.calls[1]?.[1]).toEqual({
        expectedHeadId: "toast-entry",
      });
    });
  });

  describe("behind this tab's edit saves", () => {
    const head = (id: string) => id as HistoryEntryId;
    const flushTurns = async () => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    };

    it("waits for a save still loading its boundary token, then expects the head it left", async () => {
      let finishSave!: () => void;
      const gate = new Promise<void>((resolve) => {
        finishSave = resolve;
      });
      void trackEditSave(
        "/tmp/ep",
        gate.then(() => noteSaveLanded("/tmp/ep", head("after-trim"))),
      );
      vi.mocked(undoHistory).mockResolvedValueOnce(head("before-trim"));

      const undo = execute("history.undo");
      await flushTurns();
      expect(undoHistory).not.toHaveBeenCalled();

      finishSave();
      expect(await undo).toEqual({ status: "ok" });
      expect(vi.mocked(undoHistory).mock.calls).toEqual([
        ["/tmp/ep", { expectedHeadId: "after-trim" }],
      ]);
    });

    it("waits for a live send that has gone out and expects the head its reply left", async () => {
      const send = beginHostSend("/tmp/ep", "trim-1");
      const undo = execute("history.redo");
      await flushTurns();
      expect(redoHistory).not.toHaveBeenCalled();

      noteSaveLanded("/tmp/ep", head("after-send"));
      send.finish();
      await undo;
      expect(vi.mocked(redoHistory).mock.calls).toEqual([
        ["/tmp/ep", { expectedHeadId: "after-send" }],
      ]);
    });

    it("does not wait for a save that begins after the press", async () => {
      const undo = execute("history.undo");
      const later = beginHostSend("/tmp/ep", "nudge-2");
      await undo;
      later.finish();
      expect(vi.mocked(undoHistory).mock.calls).toEqual([
        ["/tmp/ep", { expectedHeadId: "seen-by-tab" }],
      ]);
    });

    it("keeps a toast's own entry over the head a save left", async () => {
      void trackEditSave(
        "/tmp/ep",
        Promise.resolve().then(() => noteSaveLanded("/tmp/ep", head("saved"))),
      );
      await execute("history.undo", { expectedHeadId: "toast-entry" });
      expect(vi.mocked(undoHistory).mock.calls).toEqual([
        ["/tmp/ep", { expectedHeadId: "toast-entry" }],
      ]);
    });

    it("gives up on a stalled save after the host send wait and lets the server judge the head", async () => {
      vi.useFakeTimers();
      try {
        const stalled = beginHostSend("/tmp/ep", "stalled");
        const undo = execute("history.undo");
        await vi.advanceTimersByTimeAsync(HOST_SEND_WAIT_MS - 1);
        expect(undoHistory).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await undo;
        stalled.finish();
        expect(vi.mocked(undoHistory).mock.calls).toEqual([
          ["/tmp/ep", { expectedHeadId: "seen-by-tab" }],
        ]);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
