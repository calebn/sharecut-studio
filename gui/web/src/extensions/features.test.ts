import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchFeatures,
  peekCachedFeatures,
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

  it("asks again after a reset while a hung ask is still out, and the hung one answering late neither ends the new one nor fills the cache", async () => {
    const answers: Array<(res: Response) => void> = [];
    const fetcher = vi.fn(
      (_input: RequestInfo | URL) =>
        new Promise<Response>((resolve) => answers.push(resolve)),
    );
    vi.stubGlobal("fetch", fetcher);
    const hung = fetchFeatures("/r/tok");
    void fetchFeatures("/r/tok");
    expect(fetcher).toHaveBeenCalledTimes(1);
    resetFeaturesCache();
    const again = fetchFeatures("/r/tok");
    expect(fetcher).toHaveBeenCalledTimes(2);
    const reply = () =>
      new Response(
        JSON.stringify({ api_version: 1, features: ["share.ui.routes"] }),
        { status: 200 },
      );
    answers[0]?.(reply());
    await hung;
    expect(peekCachedFeatures()).toBeNull();
    void fetchFeatures("/r/tok");
    expect(fetcher).toHaveBeenCalledTimes(2);
    answers[1]?.(reply());
    expect((await again).features).toContain("share.ui.routes");
    expect(peekCachedFeatures()?.features).toContain("share.ui.routes");
  });
});
