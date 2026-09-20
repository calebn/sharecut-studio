import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";

describe("mcp.connect", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    useDawStore.setState({ hostMcpDialogOpen: false });
  });

  afterEach(() => {
    clearRegisteredCommands();
  });

  it("opens the local MCP dialog for a host project", async () => {
    const result = await execute("mcp.connect");
    expect(result).toEqual({ status: "ok" });
    expect(useDawStore.getState().hostMcpDialogOpen).toBe(true);
  });

  it("opens when no episode is loaded (DawApp still mounted)", async () => {
    useDawStore.setState({ project: null, projectPath: "" });
    const result = await execute("mcp.connect");
    expect(result).toEqual({ status: "ok" });
    expect(useDawStore.getState().hostMcpDialogOpen).toBe(true);
  });

  it("disables for share guests", async () => {
    useDawStore.setState({ projectPath: "share:fantastic-acoustic-whale" });
    const result = await execute("mcp.connect");
    expect(result.status).toBe("disabled");
    expect(useDawStore.getState().hostMcpDialogOpen).toBe(false);
  });
});
