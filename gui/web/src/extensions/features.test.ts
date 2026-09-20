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
    resetFeaturesCache();
  });

  it("fetches record-scoped features on /rec/", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      expect(input).toBe("/api/rec/roomtok/features");
      return new Response(
        JSON.stringify({ api_version: 1, features: ["share.ui.routes"] }),
        { status: 200 },
      );
    }) as typeof fetch;
    const manifest = await fetchFeatures(fetcher, "/rec/roomtok");
    expect(manifest.features).toContain("share.ui.routes");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
