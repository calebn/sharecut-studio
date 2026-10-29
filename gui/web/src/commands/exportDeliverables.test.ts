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
    setChrome({ exportRequested: false });
    useDawStore.setState({
      projectPath: "/tmp/test/episode.sharecut",
      project: minimalProject(),
      guestMode: null,
      stage: "edit",
    });
  });

  it("goes to Deliver and asks for the export instead of starting a render", async () => {
    expect(
      await execute("export.deliverables", {}, { skipWhen: true }),
    ).toEqual({ status: "ok" });
    expect(useDawStore.getState().chrome.exportRequested).toBe(true);
    expect(useDawStore.getState().stage).toBe("deliver");
    expect(api.startExportJob).not.toHaveBeenCalled();
  });

  it("asks for nothing without a loaded host project", async () => {
    useDawStore.setState({ project: null, stage: "edit" });
    expect(
      await execute("export.deliverables", {}, { skipWhen: true }),
    ).toEqual({ status: "disabled", reason: "No project loaded" });
    expect(useDawStore.getState().chrome.exportRequested).toBe(false);
    expect(useDawStore.getState().stage).toBe("edit");
  });
});
