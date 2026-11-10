import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { SNAP_STORAGE_KEY } from "../utils/snapPref";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";

describe("view.toggleSnap", () => {
  beforeEach(() => {
    localStorage.clear();
    clearRegisteredCommands();
    registerDawCommands();
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    useDawStore.setState({ snapEnabled: true });
  });

  afterEach(() => {
    clearRegisteredCommands();
    useDawStore.setState({ snapEnabled: true });
  });

  it("flips the preference, announces it and remembers it", async () => {
    expect((await execute("view.toggleSnap")).status).toBe("ok");
    expect(useDawStore.getState().snapEnabled).toBe(false);
    expect(useDawStore.getState().statusAnnouncement).toBe("Snap off");
    expect(localStorage.getItem(SNAP_STORAGE_KEY)).toBe("off");

    expect((await execute("view.toggleSnap")).status).toBe("ok");
    expect(useDawStore.getState().snapEnabled).toBe(true);
    expect(useDawStore.getState().statusAnnouncement).toBe("Snap on");
    expect(localStorage.getItem(SNAP_STORAGE_KEY)).toBe("on");
  });

  it("is unavailable with no project open", async () => {
    useDawStore.setState({ project: null });
    const result = await execute("view.toggleSnap");
    expect(result.status).toBe("disabled");
    expect(useDawStore.getState().snapEnabled).toBe(true);
  });
});
