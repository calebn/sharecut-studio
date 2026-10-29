import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHostShare } from "./sharesRecord";

const hostFetch = vi.fn();

describe("createHostShare", () => {
  beforeEach(() => {
    hostFetch.mockReset();
    vi.stubGlobal("fetch", hostFetch);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("preserves the typed stale-mix conflict for recovery callers", async () => {
    hostFetch.mockResolvedValue(
      new Response(JSON.stringify({ detail: "Refresh the mix first." }), {
        status: 409,
        headers: { "X-Sharecut-Error-Code": "stale_mix" },
      }),
    );

    await expect(
      createHostShare("/tmp/episode.sharecut", { role: "commenter" }),
    ).rejects.toMatchObject({
      name: "ApiError",
      code: "stale_mix",
      status: 409,
      message: "Refresh the mix first.",
    });
  });
});
