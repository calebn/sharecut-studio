import { beforeEach, describe, expect, it } from "vitest";
import { matchKeymapCommands } from "../keymap/registry";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";

describe("Script commands", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    useDawStore.getState().hydrate("/tmp/script-cmd.json", minimalProject());
    useDawStore.setState({ scriptCollapsed: false, scriptFocus: false });
  });

  it("view.toggleScript flips the Script pane and says so", async () => {
    expect(await execute("view.toggleScript")).toEqual({ status: "ok" });
    expect(useDawStore.getState().scriptCollapsed).toBe(true);
    expect(useDawStore.getState().statusAnnouncement).toBe("Script hidden");
    await execute("view.toggleScript");
    expect(useDawStore.getState().scriptCollapsed).toBe(false);
    expect(useDawStore.getState().statusAnnouncement).toBe("Script shown");
  });

  it("view.scriptFocus flips Script focus", async () => {
    await execute("view.scriptFocus");
    expect(useDawStore.getState().scriptFocus).toBe(true);
    await execute("view.scriptFocus");
    expect(useDawStore.getState().scriptFocus).toBe(false);
  });

  it("refuses both without a project", async () => {
    useDawStore.setState({ project: null });
    expect(await execute("view.toggleScript")).toMatchObject({
      status: "disabled",
    });
    expect(await execute("view.scriptFocus")).toMatchObject({
      status: "disabled",
    });
  });

  it("binds T and Shift+T, and leaves Mod+Shift+T to New track", () => {
    const key = (shift: boolean, mod = false) => ({
      key: shift ? "T" : "t",
      code: "KeyT",
      metaKey: false,
      ctrlKey: mod,
      altKey: false,
      shiftKey: shift,
    });
    expect(matchKeymapCommands(key(false)).map((c) => c.id)).toEqual([
      "view.toggleScript",
    ]);
    expect(matchKeymapCommands(key(true)).map((c) => c.id)).toEqual([
      "view.scriptFocus",
    ]);
    expect(matchKeymapCommands(key(true, true)).map((c) => c.id)).toEqual([
      "track.add",
    ]);
  });
});
