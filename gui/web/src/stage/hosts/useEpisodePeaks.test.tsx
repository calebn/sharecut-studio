import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shareProjectKey } from "../../shareMode";
import { useEpisodePeaks } from "./useEpisodePeaks";

const READY = {
  status: "ready",
  key: "stemkey",
  sample_rate: 10,
  channels: 1,
  total_frames: 40,
  base_spp: 10,
  level_factor: 4,
  bins_per_tile: 4096,
  levels: [
    { spp: 10, bins: 4 },
    { spp: 40, bins: 1 },
  ],
};

function route(status: unknown, tiles?: Response) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push(url);
      if (url.includes("/api/waveform/status")) return Response.json(status);
      return tiles ?? new Response(Int16Array.from([-8000, 16000, 1]).buffer);
    }),
  );
  return calls;
}

const settle = () => act(() => vi.advanceTimersByTimeAsync(0));

describe("useEpisodePeaks", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reads the coarsest level of each fresh stem", async () => {
    const calls = route({
      format_version: 1,
      media: { "stem:t1": READY },
    });
    const { result } = renderHook(() => useEpisodePeaks("/p.json", 4, "h1"));
    expect(result.current).toEqual([]);
    await settle();
    expect(calls[0]).toContain("kind=stem");
    expect(calls[1]).toContain("/api/waveform/tiles/stemkey");
    expect(calls[1]).toContain("level=1");
    expect(result.current).toHaveLength(1024);
    expect(Math.max(...result.current)).toBe(1);
  });

  it("stays empty with no stem built", async () => {
    route({ format_version: 1, media: {} });
    const { result } = renderHook(() => useEpisodePeaks("/p.json", 4, "h1"));
    await settle();
    expect(result.current).toEqual([]);
  });

  it("stays empty on an error and does not retry it", async () => {
    const fetchMock = vi.fn(async () => new Response("x", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useEpisodePeaks("/p.json", 4, "h1"));
    await settle();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(result.current).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("asks again once, after Retry-After, when the server is busy", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response("busy", { status: 503, headers: { "Retry-After": "2" } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    renderHook(() => useEpisodePeaks("/p.json", 4, "h1"));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("asks again once while a stem is generating", async () => {
    const calls = route({
      format_version: 1,
      media: { "stem:t1": { status: "generating" } },
    });
    renderHook(() => useEpisodePeaks("/p.json", 4, "h1"));
    await settle();
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(calls).toHaveLength(2);
  });

  it("does not load without a project or a length", async () => {
    const calls = route({ format_version: 1, media: {} });
    renderHook(() => useEpisodePeaks(null, 4, "h1"));
    renderHook(() => useEpisodePeaks("/p.json", 0, "h1"));
    await settle();
    expect(calls).toEqual([]);
  });
  it("skips a stem with no levels and keeps the others", async () => {
    route({
      format_version: 1,
      media: {
        "stem:t1": READY,
        "stem:t2": { ...READY, levels: [] },
      },
    });
    const { result } = renderHook(() => useEpisodePeaks("/p.json", 4, "h1"));
    await settle();
    expect(result.current).toHaveLength(1024);
  });

  it("keeps the peaks of a stem when another stem's tiles fail", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("/api/waveform/status"))
          return Response.json({
            format_version: 1,
            media: {
              "stem:t1": READY,
              "stem:t2": { ...READY, key: "ffffffffffffffffffff" },
            },
          });
        if (url.includes("ffffffffffffffffffff"))
          return new Response("gone", { status: 404 });
        return new Response(Int16Array.from([-8000, 16000, 1]).buffer);
      }),
    );
    const { result } = renderHook(() => useEpisodePeaks("/p.json", 4, "h1"));
    await settle();
    expect(result.current).toHaveLength(1024);
    expect(Math.max(...result.current)).toBe(1);
  });

  it("does not load for a share link", async () => {
    const calls = route({ format_version: 1, media: {} });
    renderHook(() => useEpisodePeaks(shareProjectKey("abc"), 4, "h1"));
    await settle();
    expect(calls).toEqual([]);
  });

  it("reloads a returning revision and keeps the newer peaks after an old reply", async () => {
    let statusReads = 0;
    const pending: ((response: Response) => void)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("/api/waveform/status")) {
          statusReads += 1;
          if (statusReads === 1)
            return Response.json({
              format_version: 1,
              media: { "stem:t1": READY },
            });
          return new Promise<Response>((resolve) => {
            pending.push(resolve);
          });
        }
        return new Response(
          Int16Array.from(
            url.includes("freshkey")
              ? [-8000, 16000, 1, -16000, 8000, 1]
              : [-8000, 16000, 1],
          ).buffer,
        );
      }),
    );
    const { result, rerender } = renderHook(
      ({ revision }) => useEpisodePeaks("/p.json", 8, revision),
      { initialProps: { revision: "h1" } },
    );
    await settle();
    expect(result.current[512]).toBe(0);
    rerender({ revision: "h2" });
    rerender({ revision: "h1" });
    expect(result.current).toEqual([]);
    expect(statusReads).toBe(3);
    pending[1]!(
      Response.json({
        format_version: 1,
        media: { "stem:t1": { ...READY, key: "freshkey" } },
      }),
    );
    await settle();
    expect(result.current[512]).toBe(1);
    pending[0]!(
      Response.json({ format_version: 1, media: { "stem:t1": READY } }),
    );
    await settle();
    expect(result.current[512]).toBe(1);
  });
});
