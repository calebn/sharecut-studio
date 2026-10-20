import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../utils/apiError";
import { cachedFetchArrayBuffer } from "./chunkCache";

afterEach(() => vi.unstubAllGlobals());

for (const cacheAvailable of [false, true]) {
  describe(`chunk fetch with CacheStorage ${cacheAvailable}`, () => {
    it("preserves unavailable generation code and status", async () => {
      vi.stubGlobal(
        "caches",
        cacheAvailable
          ? { open: async () => ({ match: async () => undefined }) }
          : undefined,
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response("Generation unavailable", {
              status: 404,
              headers: {
                "X-Sharecut-Error-Code": "proxy_generation_unavailable",
              },
            }),
        ),
      );
      await expect(
        cachedFetchArrayBuffer("share:t", "/chunk"),
      ).rejects.toMatchObject({
        name: "ApiError",
        code: "proxy_generation_unavailable",
        status: 404,
      });
    });

    it("preserves ordinary transport failure without inventing a code", async () => {
      vi.stubGlobal(
        "caches",
        cacheAvailable
          ? { open: async () => ({ match: async () => undefined }) }
          : undefined,
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("No chunk", { status: 404 })),
      );
      const error = await cachedFetchArrayBuffer("share:t", "/chunk").catch(
        (error: unknown) => error,
      );
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ code: null, status: 404 });
      expect(fetch).toHaveBeenCalledOnce();
    });
  });
}
