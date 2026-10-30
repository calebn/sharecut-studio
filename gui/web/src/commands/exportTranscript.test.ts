import { beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { setChrome } from "../test/chrome";
import { minimalProject } from "../test/fixtures";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";

describe("export.transcript", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    setChrome({ transcriptRequested: false });
    useDawStore.setState({
      projectPath: "/tmp/test/episode.sharecut",
      project: minimalProject(),
      guestMode: null,
      stage: "edit",
    });
  });

  it("opens Deliver and asks for the Transcript section", async () => {
    expect(await execute("export.transcript", {}, { skipWhen: true })).toEqual({
      status: "ok",
    });
    expect(useDawStore.getState().chrome.transcriptRequested).toBe(true);
    expect(useDawStore.getState().stage).toBe("deliver");
  });

  it("does nothing without a loaded host project", async () => {
    useDawStore.setState({ project: null, stage: "edit" });
    expect(await execute("export.transcript", {}, { skipWhen: true })).toEqual({
      status: "disabled",
      reason: "No project loaded",
    });
    expect(useDawStore.getState().chrome.transcriptRequested).toBe(false);
    expect(useDawStore.getState().stage).toBe("edit");
  });
});
