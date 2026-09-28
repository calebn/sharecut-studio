import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { useDawStore } from "../state/dawStore";
import { deferred } from "../test/deferred";
import { minimalProject } from "../test/fixtures";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, addChapter: vi.fn() };
});

describe("edit.addChapter", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    vi.mocked(api.addChapter).mockReset();
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    useDawStore.getState().setLayerVisible("showMarkers", true);
  });

  it("is host-only: disabled with 'No project loaded' when no project is loaded", async () => {
    useDawStore.setState({ project: null });
    const result = await execute("edit.addChapter", {}, { skipWhen: true });
    expect(result).toEqual({ status: "disabled", reason: "No project loaded" });
    expect(api.addChapter).not.toHaveBeenCalled();
  });

  it("adds a chapter titled from the playhead and selects it", async () => {
    vi.mocked(api.addChapter).mockResolvedValue(undefined);
    useDawStore.getState().setPlayheadSec(12.34);
    const result = await execute("edit.addChapter", {}, { skipWhen: true });
    expect(result).toEqual({ status: "ok" });
    expect(api.addChapter).toHaveBeenCalledWith(
      "/tmp/p.json",
      12.34,
      "Chapter 12.3s",
    );
    expect(useDawStore.getState().selection).toEqual({
      kind: "chapter",
      id: "Chapter 12.3s",
      time: 12.34,
    });
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Chapter added at 12.3s",
    );
  });

  it("turns the Markers layer on, even if it was off", async () => {
    useDawStore.getState().setLayerVisible("showMarkers", false);
    vi.mocked(api.addChapter).mockResolvedValue(undefined);
    await execute("edit.addChapter", {}, { skipWhen: true });
    expect(useDawStore.getState().layers.showMarkers).toBe(true);
  });

  it("is single-flight: a second call while one is in flight is disabled", async () => {
    const pending = deferred<void>();
    vi.mocked(api.addChapter).mockReturnValue(pending.promise);
    const first = execute("edit.addChapter", {}, { skipWhen: true });
    expect(useDawStore.getState().chapterAddPending).toBe(true);
    const second = await execute("edit.addChapter", {}, { skipWhen: true });
    expect(second).toEqual({
      status: "disabled",
      reason: "Add already in progress",
    });
    expect(api.addChapter).toHaveBeenCalledTimes(1);
    pending.resolve();
    await first;
    expect(useDawStore.getState().chapterAddPending).toBe(false);
  });

  it("announces and reports the failure, clearing chapterAddPending", async () => {
    vi.mocked(api.addChapter).mockRejectedValue(new Error("locked"));
    const result = await execute("edit.addChapter", {}, { skipWhen: true });
    expect(result).toEqual({ status: "disabled", reason: "locked" });
    expect(useDawStore.getState().statusAnnouncement).toBe(
      "Add chapter failed: locked",
    );
    expect(useDawStore.getState().chapterAddPending).toBe(false);
  });

  it("does not select, announce or clear pending for a settled add whose project has since changed", async () => {
    useDawStore.setState({ selection: null, statusAnnouncement: "" });
    const pending = deferred<void>();
    vi.mocked(api.addChapter).mockReturnValue(pending.promise);
    const run = execute("edit.addChapter", {}, { skipWhen: true });
    await vi.waitFor(() => expect(api.addChapter).toHaveBeenCalledOnce());

    useDawStore.getState().hydrate("/tmp/other.json", minimalProject());
    useDawStore.getState().setChapterAddPending(true);
    pending.resolve();
    expect((await run).status).toBe("ok");

    expect(useDawStore.getState().projectPath).toBe("/tmp/other.json");
    expect(useDawStore.getState().selection).toBeNull();
    expect(useDawStore.getState().statusAnnouncement).not.toContain(
      "Chapter added",
    );
    // The new project's own pending flag is left alone by the stale settle.
    expect(useDawStore.getState().chapterAddPending).toBe(true);
  });

  it("builds the title from the current playhead time", async () => {
    vi.mocked(api.addChapter).mockResolvedValue(undefined);
    useDawStore.getState().setPlayheadSec(0);
    await execute("edit.addChapter", {}, { skipWhen: true });
    expect(api.addChapter).toHaveBeenLastCalledWith(
      "/tmp/p.json",
      0,
      "Chapter 0.0s",
    );
  });
});
