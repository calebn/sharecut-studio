import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { redoHistory, undoHistory } from "../api";
import {
  documentAuthority,
  documentScope,
  noteOwnCommandHead,
  resetDocumentAuthority,
} from "../document/authorityState";
import { useDawStore } from "../state/dawStore";
import {
  beginDocumentSend,
  DOCUMENT_SEND_WAIT_MS,
  noteSaveLanded,
  trackDocumentDrain,
  trackEditSave,
} from "../state/documentSendOrder";
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
    resetDocumentAuthority("/tmp/ep");
    documentAuthority.seq = 1;
  });

  it("sends the head this tab shows after its pending mix edits are saved", async () => {
    vi.mocked(flushPendingMix).mockImplementationOnce(async () => {
      showHead("after-fader-save");
    });
    expect(await execute("history.undo")).toEqual({ status: "ok" });
    expect(undoHistory).toHaveBeenCalledWith("/tmp/ep", {
      expectedHeadId: "after-fader-save",
      scope: expect.objectContaining({
        path: expect.any(String),
        generation: expect.any(Number),
      }),
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
      scope: expect.objectContaining({
        path: expect.any(String),
        generation: expect.any(Number),
      }),
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

    it.each(["undo", "redo"] as const)(
      "refuses an obsolete %s waiting behind another history move",
      async (action) => {
        const first = heldReply();
        vi.mocked(undoHistory).mockImplementationOnce(() => first.reply);
        const one = execute("history.undo");
        await vi.waitFor(() => expect(undoHistory).toHaveBeenCalledTimes(1));
        const obsolete = execute(`history.${action}`);
        resetDocumentAuthority("/tmp/ep");
        first.release(head("old-generation-head"));
        expect(await one).toEqual({ status: "ok" });
        const reason =
          action === "undo"
            ? "Can't undo: the project changed since. Nothing was undone."
            : "Can't redo: the project changed since. Nothing was redone.";
        expect(await obsolete).toEqual({
          status: "disabled",
          reason,
          announced: true,
        });
        expect(vi.mocked(undoHistory).mock.calls).toEqual([
          [
            "/tmp/ep",
            {
              expectedHeadId: "seen-by-tab",
              scope: expect.objectContaining({
                path: expect.any(String),
                generation: expect.any(Number),
              }),
            },
          ],
        ]);
        expect(redoHistory).not.toHaveBeenCalled();
      },
    );

    it.each(["undo", "redo"] as const)(
      "refuses an obsolete %s after pending mix flush reopens the project",
      async (action) => {
        vi.mocked(flushPendingMix).mockImplementationOnce(async () => {
          resetDocumentAuthority("/tmp/ep");
        });
        const reason =
          action === "undo"
            ? "Can't undo: the project changed since. Nothing was undone."
            : "Can't redo: the project changed since. Nothing was redone.";
        expect(await execute(`history.${action}`)).toEqual({
          status: "disabled",
          reason,
          announced: true,
        });
        expect(useDawStore.getState().statusAnnouncement).toBe(reason);
        expect(undoHistory).not.toHaveBeenCalled();
        expect(redoHistory).not.toHaveBeenCalled();
      },
    );

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
        [
          "/tmp/ep",
          {
            expectedHeadId: "seen-by-tab",
            scope: expect.objectContaining({
              path: expect.any(String),
              generation: expect.any(Number),
            }),
          },
        ],
        [
          "/tmp/ep",
          {
            expectedHeadId: "after-first",
            scope: expect.objectContaining({
              path: expect.any(String),
              generation: expect.any(Number),
            }),
          },
        ],
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
        {
          expectedHeadId: "seen-by-tab",
          scope: expect.objectContaining({
            path: expect.any(String),
            generation: expect.any(Number),
          }),
        },
        {
          expectedHeadId: "landed-1",
          scope: expect.objectContaining({
            path: expect.any(String),
            generation: expect.any(Number),
          }),
        },
        {
          expectedHeadId: "landed-2",
          scope: expect.objectContaining({
            path: expect.any(String),
            generation: expect.any(Number),
          }),
        },
      ]);
      expect(redoHistory).toHaveBeenCalledWith("/tmp/ep", {
        expectedHeadId: "landed-3",
        scope: expect.objectContaining({
          path: expect.any(String),
          generation: expect.any(Number),
        }),
      });
    });

    it("expects where its own move landed while the tab still shows where it started", async () => {
      vi.mocked(undoHistory)
        .mockImplementationOnce(async () => {
          noteOwnCommandHead(documentScope(), {
            seq: 2,
            displayedFrom: head("seen-by-tab"),
            head: head("own-landing"),
          });
          return head("own-landing");
        })
        .mockResolvedValueOnce(null);

      await execute("history.undo");
      await execute("history.undo");

      expect(vi.mocked(undoHistory).mock.calls[1]?.[1]).toEqual({
        expectedHeadId: "own-landing",
        scope: expect.objectContaining({
          path: expect.any(String),
          generation: expect.any(Number),
        }),
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
        scope: expect.objectContaining({
          path: expect.any(String),
          generation: expect.any(Number),
        }),
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
        scope: expect.objectContaining({
          path: expect.any(String),
          generation: expect.any(Number),
        }),
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
        {
          expectedHeadId: "seen-by-tab",
          scope: expect.objectContaining({
            path: expect.any(String),
            generation: expect.any(Number),
          }),
        },
        {
          expectedHeadId: "seen-by-tab",
          scope: expect.objectContaining({
            path: expect.any(String),
            generation: expect.any(Number),
          }),
        },
      ]);
    });

    it("keeps a toast's own entry even when it waits behind a Mod+Z", async () => {
      vi.mocked(undoHistory).mockResolvedValueOnce(head("after-modz"));

      await Promise.all([
        execute("history.undo"),
        execute("history.undo", {
          expectedHeadId: "toast-entry",
          scope: expect.objectContaining({
            path: expect.any(String),
            generation: expect.any(Number),
          }),
        }),
      ]);

      expect(vi.mocked(undoHistory).mock.calls[1]?.[1]).toEqual({
        expectedHeadId: "toast-entry",
        scope: expect.objectContaining({
          path: expect.any(String),
          generation: expect.any(Number),
        }),
      });
    });
  });

  describe("behind this tab's edit saves", () => {
    const head = (id: string) => id as HistoryEntryId;
    const flushTurns = async () => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
    };

    describe("says that the press is waiting", () => {
      const open: Array<() => Promise<void>> = [];
      afterEach(async () => {
        await Promise.all(open.splice(0).map((settle) => settle()));
      });
      const holdSave = () => {
        let finish: () => void = () => {};
        const save = new Promise<void>((resolve) => {
          finish = resolve;
        });
        void trackEditSave("/tmp/ep", save);
        const settle = async () => {
          finish();
          await save;
        };
        open.push(settle);
        return settle;
      };

      it("says Undo runs after the save, once, and runs it when the save ends", async () => {
        const settle = holdSave();
        const pending = execute("history.undo");
        await flushTurns();
        expect(useDawStore.getState().statusAnnouncement).toBe(
          "Undo runs after save",
        );
        expect(useDawStore.getState().feedbackToast?.message).toBe(
          "Undo runs after save",
        );
        expect(undoHistory).not.toHaveBeenCalled();
        await settle();
        expect(await pending).toEqual({ status: "ok" });
        expect(undoHistory).toHaveBeenCalledTimes(1);
      });

      it("says Redo runs after the save", async () => {
        const settle = holdSave();
        const pending = execute("history.redo");
        await flushTurns();
        expect(useDawStore.getState().statusAnnouncement).toBe(
          "Redo runs after save",
        );
        await settle();
        await pending;
        expect(redoHistory).toHaveBeenCalledTimes(1);
      });

      it("waits for an offline drain that is running and says so", async () => {
        let endDrain: () => void = () => {};
        const drain = new Promise<void>((resolve) => {
          endDrain = resolve;
        });
        trackDocumentDrain("/tmp/ep", drain);
        open.push(async () => {
          endDrain();
          await drain;
        });
        const pending = execute("history.undo");
        await flushTurns();
        expect(useDawStore.getState().statusAnnouncement).toBe(
          "Undo runs after save",
        );
        expect(undoHistory).not.toHaveBeenCalled();
        endDrain();
        await drain;
        expect(await pending).toEqual({ status: "ok" });
        expect(undoHistory).toHaveBeenCalledTimes(1);
      });

      it("stays quiet when nothing is saving", async () => {
        expect(await execute("history.undo")).toEqual({ status: "ok" });
        expect(useDawStore.getState().statusAnnouncement).toBe("");
      });
    });

    it("undoes from a same-tab save that landed before the press", async () => {
      const projectPath = "/tmp/ep-history-save-landed-before-undo-press";
      useDawStore.setState({ projectPath });
      const scope = resetDocumentAuthority(projectPath);
      noteSaveLanded(projectPath, head("after-host-approval"), scope);
      noteOwnCommandHead(scope, {
        seq: 2,
        displayedFrom: head("seen-by-tab"),
        head: head("after-host-approval"),
      });

      expect(await execute("history.undo")).toEqual({ status: "ok" });

      expect(undoHistory).toHaveBeenCalledWith(projectPath, {
        expectedHeadId: "after-host-approval",
        scope: expect.objectContaining({
          path: expect.any(String),
          generation: expect.any(Number),
        }),
      });
    });

    it("uses an observed later peer head instead of the completed own reply", async () => {
      noteOwnCommandHead(documentScope(), {
        seq: 2,
        displayedFrom: head("seen-by-tab"),
        head: head("after-host-approval"),
      });
      documentAuthority.seq = 3;
      showHead("later-peer-head");
      await execute("history.undo");
      expect(undoHistory).toHaveBeenCalledWith("/tmp/ep", {
        expectedHeadId: "later-peer-head",
        scope: expect.objectContaining({
          path: expect.any(String),
          generation: expect.any(Number),
        }),
      });
    });

    it("does not reuse an own reply after a newer peer delta starts recovery", async () => {
      noteOwnCommandHead(documentScope(), {
        seq: 2,
        displayedFrom: head("seen-by-tab"),
        head: head("after-host-approval"),
      });
      documentAuthority.phase = { kind: "recovering", minimum: 3 };
      await execute("history.undo");
      expect(undoHistory).toHaveBeenCalledWith("/tmp/ep", {
        expectedHeadId: "seen-by-tab",
        scope: expect.objectContaining({
          path: expect.any(String),
          generation: expect.any(Number),
        }),
      });
    });

    it("chains subsequent undo and redo while display predates the approval", async () => {
      noteOwnCommandHead(documentScope(), {
        seq: 4,
        displayedFrom: head("seen-by-tab"),
        head: head("after-host-approval"),
      });
      vi.mocked(undoHistory)
        .mockImplementationOnce(async () => {
          noteOwnCommandHead(documentScope(), {
            seq: 5,
            displayedFrom: head("seen-by-tab"),
            head: head("before-approval"),
          });
          return head("before-approval");
        })
        .mockImplementationOnce(async () => {
          noteOwnCommandHead(documentScope(), {
            seq: 6,
            displayedFrom: head("seen-by-tab"),
            head: head("before-earlier-edit"),
          });
          return head("before-earlier-edit");
        });
      vi.mocked(redoHistory).mockResolvedValueOnce(head("before-approval"));
      await execute("history.undo");
      await execute("history.undo");
      await execute("history.redo");
      expect(vi.mocked(undoHistory).mock.calls.map((call) => call[1])).toEqual([
        {
          expectedHeadId: "after-host-approval",
          scope: expect.objectContaining({
            path: expect.any(String),
            generation: expect.any(Number),
          }),
        },
        {
          expectedHeadId: "before-approval",
          scope: expect.objectContaining({
            path: expect.any(String),
            generation: expect.any(Number),
          }),
        },
      ]);
      expect(redoHistory).toHaveBeenCalledWith("/tmp/ep", {
        expectedHeadId: "before-earlier-edit",
        scope: expect.objectContaining({
          path: expect.any(String),
          generation: expect.any(Number),
        }),
      });
    });

    it("expires a move's lagging display alias when applied peer sequence advances", async () => {
      noteOwnCommandHead(documentScope(), {
        seq: 2,
        displayedFrom: head("seen-by-tab"),
        head: head("after-host-approval"),
      });
      vi.mocked(undoHistory).mockResolvedValueOnce(head("before-approval"));
      await execute("history.undo");
      documentAuthority.seq = 3;
      await execute("history.undo");
      expect(vi.mocked(undoHistory).mock.calls[1]?.[1]).toEqual({
        expectedHeadId: "seen-by-tab",
        scope: expect.objectContaining({
          path: expect.any(String),
          generation: expect.any(Number),
        }),
      });
    });

    it("forgets an observation and own move when the same project reopens", async () => {
      noteOwnCommandHead(documentScope(), {
        seq: 2,
        displayedFrom: head("seen-by-tab"),
        head: head("after-host-approval"),
      });
      vi.mocked(undoHistory).mockResolvedValueOnce(head("before-approval"));
      await execute("history.undo");
      noteOwnCommandHead(documentScope(), {
        seq: 3,
        displayedFrom: head("seen-by-tab"),
        head: head("another-old-scope-edit"),
      });
      resetDocumentAuthority("/tmp/ep");
      await execute("history.undo");
      expect(vi.mocked(undoHistory).mock.calls[1]?.[1]).toEqual({
        expectedHeadId: "seen-by-tab",
        scope: expect.objectContaining({
          path: expect.any(String),
          generation: expect.any(Number),
        }),
      });
    });

    it.each(["null", "refused"])(
      "retains the completed own reply after a %s move",
      async (outcome) => {
        noteOwnCommandHead(documentScope(), {
          seq: 2,
          displayedFrom: head("seen-by-tab"),
          head: head("after-host-approval"),
        });
        if (outcome === "null")
          vi.mocked(undoHistory).mockResolvedValueOnce(null);
        else
          vi.mocked(undoHistory).mockRejectedValueOnce(
            new ApiError("Did not undo", "history_stale", 409),
          );
        await execute("history.undo");
        await execute("history.undo");
        expect(
          vi.mocked(undoHistory).mock.calls.map((call) => call[1]),
        ).toEqual([
          {
            expectedHeadId: "after-host-approval",
            scope: expect.objectContaining({
              path: expect.any(String),
              generation: expect.any(Number),
            }),
          },
          {
            expectedHeadId: "after-host-approval",
            scope: expect.objectContaining({
              path: expect.any(String),
              generation: expect.any(Number),
            }),
          },
        ]);
      },
    );

    it("waits for a save still loading its boundary token, then expects the head it left", async () => {
      let finishSave!: () => void;
      const gate = new Promise<void>((resolve) => {
        finishSave = resolve;
      });
      const scope = documentScope();
      void trackEditSave(
        "/tmp/ep",
        gate.then(() => noteSaveLanded("/tmp/ep", head("after-trim"), scope)),
      );
      vi.mocked(undoHistory).mockResolvedValueOnce(head("before-trim"));

      const undo = execute("history.undo");
      await flushTurns();
      expect(undoHistory).not.toHaveBeenCalled();

      finishSave();
      expect(await undo).toEqual({ status: "ok" });
      expect(vi.mocked(undoHistory).mock.calls).toEqual([
        [
          "/tmp/ep",
          {
            expectedHeadId: "after-trim",
            scope: expect.objectContaining({
              path: expect.any(String),
              generation: expect.any(Number),
            }),
          },
        ],
      ]);
    });

    it("waits for a live send that has gone out and expects the head its reply left", async () => {
      const send = beginDocumentSend("/tmp/ep", "trim-1");
      const undo = execute("history.redo");
      await flushTurns();
      expect(redoHistory).not.toHaveBeenCalled();

      noteSaveLanded("/tmp/ep", head("after-send"), documentScope());
      send.finish();
      await undo;
      expect(vi.mocked(redoHistory).mock.calls).toEqual([
        [
          "/tmp/ep",
          {
            expectedHeadId: "after-send",
            scope: expect.objectContaining({
              path: expect.any(String),
              generation: expect.any(Number),
            }),
          },
        ],
      ]);
    });

    it("does not wait for a save that begins after the press", async () => {
      const undo = execute("history.undo");
      const later = beginDocumentSend("/tmp/ep", "nudge-2");
      await undo;
      later.finish();
      expect(vi.mocked(undoHistory).mock.calls).toEqual([
        [
          "/tmp/ep",
          {
            expectedHeadId: "seen-by-tab",
            scope: expect.objectContaining({
              path: expect.any(String),
              generation: expect.any(Number),
            }),
          },
        ],
      ]);
    });

    it("keeps a toast's own entry over the head a save left", async () => {
      const scope = documentScope();
      void trackEditSave(
        "/tmp/ep",
        Promise.resolve().then(() =>
          noteSaveLanded("/tmp/ep", head("saved"), scope),
        ),
      );
      await execute("history.undo", {
        expectedHeadId: "toast-entry",
        scope: expect.objectContaining({
          path: expect.any(String),
          generation: expect.any(Number),
        }),
      });
      expect(vi.mocked(undoHistory).mock.calls).toEqual([
        [
          "/tmp/ep",
          {
            expectedHeadId: "toast-entry",
            scope: expect.objectContaining({
              path: expect.any(String),
              generation: expect.any(Number),
            }),
          },
        ],
      ]);
    });

    for (const action of ["undo", "redo"] as const) {
      const move = action === "undo" ? undoHistory : redoHistory;

      it(`keeps a ${action} pressed behind a live send that stays out past the host send wait, and runs it once the send lands`, async () => {
        vi.useFakeTimers();
        try {
          const slow = beginDocumentSend("/tmp/ep", "slow");
          const press = execute(`history.${action}`);
          await vi.advanceTimersByTimeAsync(DOCUMENT_SEND_WAIT_MS * 4);
          expect(move).not.toHaveBeenCalled();
          expect(useDawStore.getState().statusAnnouncement).toBe(
            `${action === "undo" ? "Undo" : "Redo"} runs after save`,
          );

          noteSaveLanded("/tmp/ep", head("after-slow-send"), documentScope());
          slow.finish();
          expect(await press).toEqual({ status: "ok" });
          expect(vi.mocked(move).mock.calls).toEqual([
            [
              "/tmp/ep",
              {
                expectedHeadId: "after-slow-send",
                scope: expect.objectContaining({
                  path: expect.any(String),
                  generation: expect.any(Number),
                }),
              },
            ],
          ]);
          expect(useDawStore.getState().feedbackToast).toBeNull();
        } finally {
          vi.useRealTimers();
        }
      });

      it(`keeps a ${action} pressed behind a save still loading its boundary token past the host send wait`, async () => {
        vi.useFakeTimers();
        try {
          const slowToken = new Promise<void>((resolve) => {
            setTimeout(resolve, DOCUMENT_SEND_WAIT_MS + 1_000);
          });
          const scope = documentScope();
          void trackEditSave(
            "/tmp/ep",
            slowToken.then(() =>
              noteSaveLanded("/tmp/ep", head("after-trim"), scope),
            ),
          );
          const press = execute(`history.${action}`);
          await vi.advanceTimersByTimeAsync(DOCUMENT_SEND_WAIT_MS);
          expect(move).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(1_000);
          expect(await press).toEqual({ status: "ok" });
          expect(vi.mocked(move).mock.calls.map((call) => call[1])).toEqual([
            expect.objectContaining({ expectedHeadId: "after-trim" }),
          ]);
        } finally {
          vi.useRealTimers();
        }
      });
    }
  });
});
