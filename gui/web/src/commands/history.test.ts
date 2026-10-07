import { beforeEach, describe, expect, it, vi } from "vitest";
import { redoHistory, undoHistory } from "../api";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import type { HistoryEntryId } from "../types/project";
import { ApiError } from "../utils/apiError";
import { clearRegisteredCommands, execute } from "./execute";
import { registerHistoryCommands } from "./history";
import { flushPendingMix } from "./trackMix";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  undoHistory: vi.fn(async () => undefined),
  redoHistory: vi.fn(async () => undefined),
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
});
