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
    useDawStore.setState({ helpDialogOpen: false });
  });

  afterEach(() => {
    clearRegisteredCommands();
  });

  it("opens Help for a host project", async () => {
    const result = await execute("help.diagnosticsBundle");
    expect(result).toEqual({ status: "ok" });
    expect(useDawStore.getState().helpDialogOpen).toBe(true);
  });

  it("disables for share guests", async () => {
    useDawStore.setState({ projectPath: "share:fantastic-acoustic-whale" });
    const result = await execute("help.diagnosticsBundle");
    expect(result.status).toBe("disabled");
    expect(useDawStore.getState().helpDialogOpen).toBe(false);
  });
});
