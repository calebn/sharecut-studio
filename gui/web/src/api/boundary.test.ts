import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadBoundaryContext } from "./boundary";

describe("boundary API", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              target: { kind: "trim", clip_id: "c1", edge: "out" },
              token: "a".repeat(64),
              track_id: "host",
              geometry: [
                {
                  id: "c1",
                  source_start: 1,
                  source_end: 4,
                  timeline_start: 10,
                  source_id: null,
                },
              ],
              current: { source_sec: 4, timeline_sec: 13 },
              limits: {
                min: 1.05,
                max: 4,
                fine_step_sec: 0.001,
                regular_step_sec: 0.01,
              },
            }),
            { status: 200 },
          ),
      ),
    );
  });

  it("sends expected visible geometry and parses the host context", async () => {
    const geometry = [
      {
        id: "c1",
        source_start: 1,
        source_end: 4,
        timeline_start: 10,
        source_id: null,
      },
    ];
    const context = await loadBoundaryContext(
      "/tmp/episode.json",
      { kind: "trim", clip_id: "c1", edge: "out" },
      geometry,
    );
    expect(context.current).toEqual({ source_sec: 4, timeline_sec: 13 });
    expect(context.limits).toEqual({
      min: 1.05,
      max: 4,
      fine_step_sec: 0.001,
      regular_step_sec: 0.01,
    });
    const [, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    const body = init?.body;
    if (typeof body !== "string") throw new Error("request body missing");
    expect(JSON.parse(body)).toEqual({
      path: "/tmp/episode.json",
      target: { kind: "trim", clip_id: "c1", edge: "out" },
      expected_geometry: geometry,
    });
  });

  it("uses the edit share endpoint without leaking a host path", async () => {
    const geometry = [
      {
        id: "c1",
        source_start: 1,
        source_end: 4,
        timeline_start: 10,
        source_id: null,
      },
    ];
    await loadBoundaryContext(
      "share:guest-token",
      { kind: "trim", clip_id: "c1", edge: "out" },
      geometry,
    );
    const [url, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    expect(url).toBe("/api/review/guest-token/daw/boundary/context");
    const body = init?.body;
    if (typeof body !== "string") throw new Error("request body missing");
    expect(JSON.parse(body)).toEqual({
      target: { kind: "trim", clip_id: "c1", edge: "out" },
      expected_geometry: geometry,
    });
  });

  it("adds the preview token and host session token as separate query parameters", async () => {
    window.history.replaceState({}, "", "/?session_token=host-auth");
    vi.resetModules();
    const { boundaryAudioUrl } = await import("./boundary");
    const url = new URL(
      boundaryAudioUrl("/api/boundary/audio/opaque", "preview-state"),
      window.location.origin,
    );
    expect(url.pathname).toBe("/api/boundary/audio/opaque");
    expect(url.searchParams.get("expected_token")).toBe("preview-state");
    expect(url.searchParams.get("token")).toBe("host-auth");
  });
});
