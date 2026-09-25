import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadWaveformPcm,
  loadWaveformStatus,
  loadWaveformTiles,
  WaveformFetchError,
} from "./api";
import { shareProjectKey } from "./shareMode";

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string"
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}

function stubFetch(response: Response) {
  const fn = vi.fn(async (_input: RequestInfo | URL) => response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

const MEDIA_HASH = "0123456789abcdef0123";

describe("waveform api", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads host status for a kind", async () => {
    const body = { format_version: 1, media: {} };
    const fetchMock = stubFetch(Response.json(body));
    await expect(loadWaveformStatus("/tmp/p.json", "stem")).resolves.toEqual(
      body,
    );
    const url = requestUrl(fetchMock.mock.calls[0]![0]);
    expect(url).toBe("/api/waveform/status?path=%2Ftmp%2Fp.json&kind=stem");
  });

  it("loads guest status through the share route, raw only", async () => {
    const fetchMock = stubFetch(
      Response.json({ format_version: 1, media: {} }),
    );
    const key = shareProjectKey("tok");
    await loadWaveformStatus(key, "raw");
    expect(requestUrl(fetchMock.mock.calls[0]![0])).toContain(
      "/api/review/tok/daw/waveform/status",
    );
    fetchMock.mockClear();
    await expect(loadWaveformStatus(key, "stem")).resolves.toEqual({
      format_version: 1,
      media: {},
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("loads host and guest tile bytes", async () => {
    const bytes = new Int16Array([1, 2, 3]).buffer;
    let fetchMock = stubFetch(new Response(bytes));
    const buf = await loadWaveformTiles("/tmp/p.json", {
      key: MEDIA_HASH,
      ref: "track:host",
      level: 2,
      start: 3,
      count: 4,
    });
    expect(new Int16Array(buf)).toEqual(new Int16Array([1, 2, 3]));
    expect(requestUrl(fetchMock.mock.calls[0]![0])).toBe(
      `/api/waveform/tiles/${MEDIA_HASH}?ref=track%3Ahost&level=2&start=3&count=4&path=%2Ftmp%2Fp.json`,
    );
    fetchMock = stubFetch(new Response(bytes));
    await loadWaveformTiles(shareProjectKey("tok"), {
      key: MEDIA_HASH,
      ref: "source:s1",
      level: 0,
      start: 0,
      count: 1,
    });
    const guestUrl = requestUrl(fetchMock.mock.calls[0]![0]);
    expect(guestUrl).toContain(
      `/api/review/tok/daw/waveform/tiles/${MEDIA_HASH}?`,
    );
    expect(guestUrl).not.toContain("path=");
  });

  it("throws the status and Retry-After on failure", async () => {
    stubFetch(
      new Response("slow down", {
        status: 429,
        headers: { "Retry-After": "3" },
      }),
    );
    const err = await loadWaveformTiles("/tmp/p.json", {
      key: MEDIA_HASH,
      ref: "track:host",
      level: 0,
      start: 0,
      count: 1,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WaveformFetchError);
    expect((err as WaveformFetchError).status).toBe(429);
    expect((err as WaveformFetchError).retryAfterSec).toBe(3);
  });

  it("loads host PCM blocks and never asks a guest route", async () => {
    const fetchMock = stubFetch(new Response(new Int16Array([5, 6]).buffer));
    await loadWaveformPcm("/tmp/p.json", {
      key: MEDIA_HASH,
      ref: "track:host",
      block: 7,
    });
    expect(requestUrl(fetchMock.mock.calls[0]![0])).toBe(
      `/api/waveform/pcm/${MEDIA_HASH}?path=%2Ftmp%2Fp.json&ref=track%3Ahost&block=7`,
    );
    fetchMock.mockClear();
    await expect(
      loadWaveformPcm(shareProjectKey("tok"), {
        key: MEDIA_HASH,
        ref: "track:host",
        block: 0,
      }),
    ).rejects.toBeInstanceOf(WaveformFetchError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
