import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPeaks } from "./api";
import { shareProjectKey } from "./shareMode";

function stubFetch(status: number, body: unknown | null, ok = status < 400) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => ({
      ok,
      status,
      url: String(input),
      json: async () => {
        if (body === null) {
          throw new Error("not json");
        }
        return body;
      },
    })),
  );
}

describe("loadPeaks", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns ready with the payload on a 200", async () => {
    const payload = {
      peaks: [1, 2, 3],
      samples_per_pixel: 500,
      sample_rate: 8000,
    };
    stubFetch(200, payload);
    await expect(loadPeaks("/tmp/p.json", "host")).resolves.toEqual({
      status: "ready",
      peaks: payload,
    });
  });

  it("returns generating on a 404 body with generating true", async () => {
    stubFetch(
      404,
      { available: false, track_id: "host", generating: true },
      false,
    );
    await expect(loadPeaks("/tmp/p.json", "host")).resolves.toEqual({
      status: "generating",
    });
  });

  it("returns unavailable on a plain 404 body", async () => {
    stubFetch(
      404,
      { available: false, track_id: "host", generating: false },
      false,
    );
    await expect(loadPeaks("/tmp/p.json", "host")).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("returns unavailable when the error body is not JSON", async () => {
    stubFetch(404, null, false);
    await expect(loadPeaks("/tmp/p.json", "host")).resolves.toEqual({
      status: "unavailable",
    });
  });

  it("hits the share review endpoint for a share project key", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => ({
      ok: true,
      status: 200,
      url: String(input),
      json: async () => ({ peaks: [], samples_per_pixel: 1, sample_rate: 1 }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    await loadPeaks(shareProjectKey("tok"), "host");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/api/review/tok/daw/peaks/host");
  });
});
