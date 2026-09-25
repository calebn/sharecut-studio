import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { useDawStore } from "../state/dawStore";
import { deferred } from "../test/deferred";
import { minimalProject } from "../test/fixtures";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";

vi.mock("../api", () => ({
  startRenderPreview: vi.fn(),
  refreshProject: vi.fn(),
  waitForPipelineJob: vi.fn(),
}));

describe("render.refreshMix project ownership", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    vi.mocked(api.startRenderPreview).mockReset();
    vi.mocked(api.refreshProject).mockReset();
    useDawStore.getState().hydrate("/tmp/project-a.json", minimalProject());
  });

  it("does not let an old refresh clear the new project's busy state", async () => {
    const oldStart = deferred<{ mode: "sync"; ok: boolean }>();
    const newStart = deferred<{ mode: "sync"; ok: boolean }>();
    vi.mocked(api.startRenderPreview)
      .mockReturnValueOnce(oldStart.promise)
      .mockReturnValueOnce(newStart.promise);
    vi.mocked(api.refreshProject).mockResolvedValue(minimalProject());

    const oldRun = execute("render.refreshMix", {}, { skipWhen: true });
    expect(useDawStore.getState().renderPreviewBusy).toBe(true);
    useDawStore.getState().hydrate("/tmp/project-b.json", minimalProject());
    const newRun = execute("render.refreshMix", {}, { skipWhen: true });
    expect(useDawStore.getState().renderPreviewBusy).toBe(true);

    oldStart.resolve({ mode: "sync", ok: true });
    expect((await oldRun).status).toBe("disabled");
    expect(useDawStore.getState().projectPath).toBe("/tmp/project-b.json");
    expect(useDawStore.getState().renderPreviewBusy).toBe(true);
    expect(api.refreshProject).not.toHaveBeenCalledWith("/tmp/project-a.json");

    newStart.resolve({ mode: "sync", ok: true });
    expect((await newRun).status).toBe("ok");
    expect(useDawStore.getState().renderPreviewBusy).toBe(false);
  });

  it("discards an old project snapshot that finishes after a switch", async () => {
    const oldProject = deferred<ReturnType<typeof minimalProject>>();
    vi.mocked(api.startRenderPreview).mockResolvedValue({
      mode: "sync",
      ok: true,
    });
    vi.mocked(api.refreshProject).mockReturnValue(oldProject.promise);

    const oldRun = execute("render.refreshMix", {}, { skipWhen: true });
    await vi.waitFor(() => expect(api.refreshProject).toHaveBeenCalledOnce());
    const projectB = minimalProject({
      meta: { name: "Project B", workspace_dir: "/tmp/b" },
    });
    useDawStore.getState().hydrate("/tmp/project-b.json", projectB);
    oldProject.resolve(
      minimalProject({
        meta: { name: "Project A", workspace_dir: "/tmp/a" },
      }),
    );

    expect((await oldRun).status).toBe("disabled");
    expect(useDawStore.getState().project).toBe(projectB);
    expect(useDawStore.getState().renderPreviewBusy).toBe(false);
  });
});
