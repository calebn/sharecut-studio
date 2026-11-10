import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";

describe("help.diagnosticsBundle", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    useDawStore.getState().setHelpDialogOpen(false);
  });

  afterEach(() => {
    clearRegisteredCommands();
  });

  it("opens Help for a host project", async () => {
    const result = await execute("help.diagnosticsBundle");
    expect(result).toEqual({ status: "ok" });
    expect(useDawStore.getState().chrome.helpDialogOpen).toBe(true);
    expect(useDawStore.getState().chrome.helpDialogStep).toBe("report");
  });

  it("disables for share guests", async () => {
    useDawStore.setState({ projectPath: "share:fantastic-acoustic-whale" });
    const result = await execute("help.diagnosticsBundle");
    expect(result.status).toBe("disabled");
    expect(useDawStore.getState().chrome.helpDialogOpen).toBe(false);
  });

  it("reports the handler's own host-only reason on a bypassed (button) call", async () => {
    useDawStore.setState({ projectPath: "share:fantastic-acoustic-whale" });
    const result = await execute(
      "help.diagnosticsBundle",
      {},
      { skipWhen: true },
    );
    expect(result).toEqual({
      status: "disabled",
      reason: "Report a problem is host-only",
    });
    expect(useDawStore.getState().chrome.helpDialogOpen).toBe(false);
  });
});

describe("help.guides", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
  });

  afterEach(() => {
    clearRegisteredCommands();
    vi.restoreAllMocks();
  });

  it("opens the documentation site in a new tab for a host and for a guest link", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    useDawStore.setState({ projectPath: "share:fantastic-acoustic-whale" });
    expect(await execute("help.guides")).toEqual({ status: "ok" });
    expect(open).toHaveBeenCalledWith(
      "https://docs.sharecut.studio/",
      "_blank",
      "noopener,noreferrer",
    );
  });
});
