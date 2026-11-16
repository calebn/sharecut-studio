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

  it("asks again after a reset while a hung ask is still out, and the hung one answering late does not end the new one", async () => {
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
    void fetchFeatures("/r/tok");
    expect(fetcher).toHaveBeenCalledTimes(2);
    answers[1]?.(reply());
    expect((await again).features).toContain("share.ui.routes");
    expect(peekCachedFeatures()?.features).toContain("share.ui.routes");
  });

  describe("a dropped ask that answers late", () => {
    const manifest = (features: string[]) =>
      new Response(JSON.stringify({ api_version: 1, features }), {
        status: 200,
      });

    function dropOne() {
      const answers: Array<(res: Response) => void> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_input: RequestInfo | URL) =>
            new Promise<Response>((resolve) => answers.push(resolve)),
        ),
      );
      const dropped = fetchFeatures("/r/tok");
      resetFeaturesCache();
      const current = fetchFeatures("/r/tok");
      return { answers, dropped, current };
    }

    it("fills an empty cache with the host's real answer", async () => {
      const { answers, dropped } = dropOne();
      answers[0]?.(manifest(["first"]));
      await dropped;
      expect(peekCachedFeatures()?.features).toEqual(["first"]);
    });

    it("does not fill the cache with its fallback", async () => {
      const { answers, dropped } = dropOne();
      answers[0]?.(new Response("no", { status: 500 }));
      await dropped;
      expect(peekCachedFeatures()).toBeNull();
    });

    it("leaves the current ask's later answer to replace what it filled", async () => {
      const { answers, dropped, current } = dropOne();
      answers[0]?.(manifest(["first"]));
      await dropped;
      answers[1]?.(manifest(["second"]));
      expect((await current).features).toEqual(["second"]);
      expect(peekCachedFeatures()?.features).toEqual(["second"]);
    });

    it("never replaces what the current ask already answered", async () => {
      const { answers, dropped, current } = dropOne();
      answers[1]?.(manifest(["second"]));
      await current;
      answers[0]?.(manifest(["first"]));
      await dropped;
      expect(peekCachedFeatures()?.features).toEqual(["second"]);
    });
  });
});
