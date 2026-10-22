import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { setChrome } from "../test/chrome";
import { minimalProject } from "../test/fixtures";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";

describe("models.open", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    setChrome({ modelsDialogOpen: false });
  });

  afterEach(() => {
    clearRegisteredCommands();
  });

  it("opens Help for a host project", async () => {
    const result = await execute("models.open");
    expect(result).toEqual({ status: "ok" });
    expect(useDawStore.getState().chrome.modelsDialogOpen).toBe(true);
  });

  it("disables for share guests", async () => {
    useDawStore.setState({ projectPath: "share:fantastic-acoustic-whale" });
    const result = await execute("models.open");
    expect(result.status).toBe("disabled");
    expect(useDawStore.getState().chrome.modelsDialogOpen).toBe(false);
  });

  it("reports the handler's own host-only reason on a bypassed (button) call", async () => {
    useDawStore.setState({ projectPath: "share:fantastic-acoustic-whale" });
    const result = await execute("models.open", {}, { skipWhen: true });
    expect(result).toEqual({
      status: "disabled",
      reason: "Manage models is host-only",
    });
    expect(useDawStore.getState().chrome.modelsDialogOpen).toBe(false);
  });
});
