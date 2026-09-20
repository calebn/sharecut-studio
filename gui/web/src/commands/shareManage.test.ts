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
    useDawStore.setState({ shareDialogOpen: false });
  });

  afterEach(() => {
    resetFeaturesCache();
    vi.unstubAllGlobals();
  });

  it("opens when features have not loaded yet", async () => {
    expect(peekCachedFeatures()).toBeNull();
    const result = await execute("share.manage");
    expect(result).toEqual({ status: "ok" });
    expect(useDawStore.getState().shareDialogOpen).toBe(true);
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
    expect(useDawStore.getState().shareDialogOpen).toBe(false);
  });

  it("opens when share.ui.menu is cached", async () => {
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
    expect(useDawStore.getState().shareDialogOpen).toBe(true);
  });
});
