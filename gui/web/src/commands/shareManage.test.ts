import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FEATURE_SHARE_UI_MENU,
  fetchFeatures,
  peekCachedFeatures,
  resetFeaturesCache,
} from "../extensions/features";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";

describe("share.manage", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    resetFeaturesCache();
    registerDawCommands();
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    useDawStore.getState().setOpenSheet(null);
  });

  afterEach(() => {
    resetFeaturesCache();
    vi.unstubAllGlobals();
  });

  it("opens the Invite sheet over the current stage when features have not loaded yet", async () => {
    expect(peekCachedFeatures()).toBeNull();
    useDawStore.getState().openStage("edit");
    const result = await execute("share.manage");
    expect(result).toEqual({ status: "ok" });
    expect(useDawStore.getState().stage).toBe("edit");
    expect(useDawStore.getState().openSheet).toBe("invite");
    expect(useDawStore.getState().inviteAt).toBeNull();
  });

  it("opens the Invite sheet at the Record links when asked", async () => {
    useDawStore.getState().openStage("record");
    const result = await execute("share.manage", { at: "record" });
    expect(result).toEqual({ status: "ok" });
    expect(useDawStore.getState().stage).toBe("record");
    expect(useDawStore.getState().openSheet).toBe("invite");
    expect(useDawStore.getState().inviteAt).toBe("record");
    useDawStore.getState().setOpenSheet(null);
    expect(useDawStore.getState().inviteAt).toBeNull();
  });

  it("disables after features load without share.ui.menu", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ api_version: 1, features: [] }),
      }),
    );
    await fetchFeatures();
    const result = await execute("share.manage");
    expect(result.status).toBe("disabled");
    expect(useDawStore.getState().openSheet).toBeNull();
  });

  it("opens the sheet when share.ui.menu is cached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          api_version: 1,
          features: [FEATURE_SHARE_UI_MENU],
        }),
      }),
    );
    await fetchFeatures();
    const result = await execute("share.manage");
    expect(result).toEqual({ status: "ok" });
    expect(useDawStore.getState().openSheet).toBe("invite");
  });
});
