import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { useDawStore } from "../state/dawStore";
import { setChrome } from "../test/chrome";
import { minimalProject } from "../test/fixtures";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  startExportJob: vi.fn(),
}));

describe("export.deliverables", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    vi.mocked(api.startExportJob).mockReset();
    setChrome({ exportDialogOpen: false });
    useDawStore.setState({
      projectPath: "/tmp/test/episode.project.json",
      project: minimalProject(),
      guestMode: null,
    });
  });

  it("opens the export dialog instead of starting a render", async () => {
    expect(
      await execute("export.deliverables", {}, { skipWhen: true }),
    ).toEqual({ status: "ok" });
    expect(useDawStore.getState().chrome.exportDialogOpen).toBe(true);
    expect(api.startExportJob).not.toHaveBeenCalled();
  });

  it("stays closed without a loaded host project", async () => {
    useDawStore.setState({ project: null });
    expect(
      await execute("export.deliverables", {}, { skipWhen: true }),
    ).toEqual({ status: "disabled", reason: "No project loaded" });
    expect(useDawStore.getState().chrome.exportDialogOpen).toBe(false);
  });
});
