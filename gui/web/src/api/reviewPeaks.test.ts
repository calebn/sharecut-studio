import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearReviewPeaksCache, loadReviewPeaks } from "./reviewPeaks";

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}

function stubFetch(make: () => Response) {
  const fn = vi.fn(async (_input: RequestInfo | URL) => make());
  vi.stubGlobal("fetch", fn);
  return fn;
}

const PEAKS = [0, 0.25, 1, 0.5];

describe("loadReviewPeaks", () => {
  beforeEach(() => clearReviewPeaksCache());
  afterEach(() => vi.unstubAllGlobals());

  it("reads the share's play-gated peaks route", async () => {
    const fetchMock = stubFetch(() => Response.json(PEAKS));
    await expect(loadReviewPeaks("tok", "v1")).resolves.toEqual(PEAKS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestUrl(fetchMock.mock.calls[0]![0])).toBe(
      "/api/review/tok/peaks?version_id=v1",
    );
  });

  it("fetches once per share and version, however often it is asked", async () => {
    const fetchMock = stubFetch(() => Response.json(PEAKS));
    await Promise.all([
      loadReviewPeaks("tok", "v1"),
      loadReviewPeaks("tok", "v1"),
    ]);
    await loadReviewPeaks("tok", "v1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fetches again for a new version of the same link, and for another share", async () => {
    const fetchMock = stubFetch(() => Response.json(PEAKS));
    await loadReviewPeaks("tok", "v1");
    await loadReviewPeaks("tok", "v2");
    await loadReviewPeaks("other", "v2");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("gives an empty strip, not an error, when the link may not play", async () => {
    stubFetch(() => new Response("denied", { status: 403 }));
    await expect(loadReviewPeaks("tok", "v1")).resolves.toEqual([]);
  });

  it("gives an empty strip for a body that is not a list of numbers", async () => {
    stubFetch(() => Response.json({ peaks: "nope" }));
    await expect(loadReviewPeaks("tok", "v1")).resolves.toEqual([]);
  });

  it("asks again after a failure instead of remembering the empty answer", async () => {
    let ok = false;
    const fetchMock = stubFetch(() =>
      ok ? Response.json(PEAKS) : new Response("busy", { status: 429 }),
    );
    await expect(loadReviewPeaks("tok", "v1")).resolves.toEqual([]);
    ok = true;
    await expect(loadReviewPeaks("tok", "v1")).resolves.toEqual(PEAKS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("asks for the version it remembers the answer under", async () => {
    const fetchMock = stubFetch(() => Response.json(PEAKS));
    await loadReviewPeaks("tok", "v 2/x");
    expect(requestUrl(fetchMock.mock.calls[0]![0])).toBe(
      "/api/review/tok/peaks?version_id=v%202%2Fx",
    );
  });

  it("does not remember an empty 200, so a decode error is asked again", async () => {
    let body: number[] = [];
    const fetchMock = stubFetch(() => Response.json(body));
    await expect(loadReviewPeaks("tok", "v1")).resolves.toEqual([]);
    body = PEAKS;
    await expect(loadReviewPeaks("tok", "v1")).resolves.toEqual(PEAKS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
