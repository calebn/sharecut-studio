import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchFeatures,
  resetFeaturesCache,
  reviewTokenFromPathname,
} from "./features";

describe("reviewTokenFromPathname", () => {
  it("wraps parseShareRoute for review only", () => {
    expect(reviewTokenFromPathname("/r/tok")).toBe("tok");
    expect(reviewTokenFromPathname("/rec/tok")).toBeNull();
  });
});

describe("fetchFeatures", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetFeaturesCache();
  });

  it("fetches record-scoped features on /rec/", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response(
          JSON.stringify({ api_version: 1, features: ["share.ui.routes"] }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetcher);
    const manifest = await fetchFeatures("/rec/roomtok");
    expect(manifest.features).toContain("share.ui.routes");
    expect(fetcher.mock.calls.map(([input]) => input)).toEqual([
      "/api/rec/roomtok/features",
    ]);
  });
});
