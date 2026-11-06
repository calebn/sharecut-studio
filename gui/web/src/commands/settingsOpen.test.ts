import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { setChrome } from "../test/chrome";
import { minimalProject } from "../test/fixtures";
import { COMMANDS } from "./catalog";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";

describe("help.settings", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    setChrome({ settingsSheetOpen: false });
  });

  afterEach(() => {
    clearRegisteredCommands();
  });

  it("is in the catalog under a label of Settings", () => {
    expect(COMMANDS["help.settings"]?.label).toBe("Settings");
  });

  it("opens the same Settings sheet the app menu opens", async () => {
    const result = await execute("help.settings");
    expect(result).toEqual({ status: "ok" });
    expect(useDawStore.getState().chrome.settingsSheetOpen).toBe(true);
  });

  it("is host-only: a share guest cannot open it", async () => {
    useDawStore.setState({ projectPath: "share:fantastic-acoustic-whale" });
    expect((await execute("help.settings")).status).toBe("disabled");
    const bypassed = await execute("help.settings", {}, { skipWhen: true });
    expect(bypassed).toEqual({
      status: "disabled",
      reason: "Settings is host-only",
    });
    expect(useDawStore.getState().chrome.settingsSheetOpen).toBe(false);
  });
});
