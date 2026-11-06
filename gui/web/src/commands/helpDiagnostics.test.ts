import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";

describe("help.diagnosticsBundle", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    useDawStore.getState().setHelpSheetOpen(false);
  });

  afterEach(() => {
    clearRegisteredCommands();
  });

  it("opens Help on its Report a problem step for a host project", async () => {
    const result = await execute("help.diagnosticsBundle");
    expect(result).toEqual({ status: "ok" });
    expect(useDawStore.getState().chrome.helpSheetOpen).toBe(true);
    expect(useDawStore.getState().chrome.helpSheetStep).toBe("report");
  });

  it("disables for share guests", async () => {
    useDawStore.setState({ projectPath: "share:fantastic-acoustic-whale" });
    const result = await execute("help.diagnosticsBundle");
    expect(result.status).toBe("disabled");
    expect(useDawStore.getState().chrome.helpSheetOpen).toBe(false);
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
    expect(useDawStore.getState().chrome.helpSheetOpen).toBe(false);
  });
});
