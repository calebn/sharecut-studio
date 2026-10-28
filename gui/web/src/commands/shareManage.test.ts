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
    useDawStore.setState({ stage: "edit" });
    useDawStore.getState().setShareRequested(false);
  });

  afterEach(() => {
    resetFeaturesCache();
    vi.unstubAllGlobals();
  });

  it("goes to Deliver and asks for Share when features have not loaded yet", async () => {
    expect(peekCachedFeatures()).toBeNull();
    const result = await execute("share.manage");
    expect(result).toEqual({ status: "ok" });
    expect(useDawStore.getState().chrome.shareRequested).toBe(true);
    expect(useDawStore.getState().stage).toBe("deliver");
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
    expect(result).toEqual({
      status: "disabled",
      reason: "Share requires the online extension",
    });
    expect(useDawStore.getState().chrome.shareRequested).toBe(false);
    expect(useDawStore.getState().stage).toBe("edit");
  });

  it("asks for Share when share.ui.menu is cached", async () => {
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
    expect(useDawStore.getState().chrome.shareRequested).toBe(true);
    expect(useDawStore.getState().stage).toBe("deliver");
  });

  it("asks for nothing without a loaded host project", async () => {
    useDawStore.setState({ project: null });
    expect(await execute("share.manage")).toEqual({
      status: "disabled",
      reason: "No project loaded",
    });
    expect(useDawStore.getState().chrome.shareRequested).toBe(false);
    expect(useDawStore.getState().stage).toBe("edit");
  });
});
