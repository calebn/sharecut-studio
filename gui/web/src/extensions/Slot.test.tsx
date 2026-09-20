import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureProvider } from "./FeatureProvider";
import {
  FEATURE_SHARE_UI_MENU,
  fetchFeatures,
  hasFeature,
  peekCachedFeatures,
  resetFeaturesCache,
} from "./features";
import { Slot } from "./Slot";

beforeEach(() => {
  resetFeaturesCache();
});

describe("extensions features", () => {
  it("hasFeature is false when absent", () => {
    expect(peekCachedFeatures()).toBeNull();
    expect(
      hasFeature({ api_version: 1, features: [] }, FEATURE_SHARE_UI_MENU),
    ).toBe(false);
    expect(
      hasFeature(
        { api_version: 1, features: [FEATURE_SHARE_UI_MENU] },
        FEATURE_SHARE_UI_MENU,
      ),
    ).toBe(true);
  });

  it("Slot renders null when feature missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ api_version: 1, features: [] }),
      }),
    );
    render(
      <FeatureProvider>
        <Slot id={FEATURE_SHARE_UI_MENU}>
          <span>Share menu</span>
        </Slot>
      </FeatureProvider>,
    );
    expect(screen.queryByText("Share menu")).toBeNull();
    // wait for ready
    await vi.waitFor(() => {
      expect(screen.queryByText("Share menu")).toBeNull();
    });
  });

  it("Slot renders children when feature present", async () => {
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
    render(
      <FeatureProvider>
        <Slot id={FEATURE_SHARE_UI_MENU}>
          <span>Share menu</span>
        </Slot>
      </FeatureProvider>,
    );
    expect(await screen.findByText("Share menu")).toBeTruthy();
  });

  it("does not permanently cache empty after a failed features fetch", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          api_version: 1,
          features: [FEATURE_SHARE_UI_MENU],
        }),
      });
    const first = await fetchFeatures(fetchMock);
    expect(first.features).toEqual([]);
    expect(peekCachedFeatures()).toBeNull();
    const second = await fetchFeatures(fetchMock);
    expect(second.features).toEqual([FEATURE_SHARE_UI_MENU]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses share-scoped features on /r/{token} guest paths", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        api_version: 1,
        features: [FEATURE_SHARE_UI_MENU, "share.ui.routes"],
      }),
    });
    const manifest = await fetchFeatures(
      fetchMock,
      "/r/ambrosial-valiant-numbat",
    );
    expect(manifest.features).toContain("share.ui.routes");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/review/ambrosial-valiant-numbat/features",
    );
  });

  it("falls back to guest share defaults when scoped features 404", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const manifest = await fetchFeatures(fetchMock, "/r/cool-token");
    expect(manifest.features).toContain("share.ui.routes");
    expect(fetchMock).toHaveBeenCalledWith("/api/review/cool-token/features");
    expect(fetchMock).not.toHaveBeenCalledWith("/api/features");
  });
});
