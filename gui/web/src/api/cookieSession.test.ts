import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PROJECT = "/tmp/ep.project.json";

/**
 * A host whose loopback is not trusted signs the web view in with a cookie, and the page
 * is opened with no `session_token`. Every URL the app builds and every request it sends
 * must then carry no token, so the cookie is the only credential in flight.
 */
describe("a page opened with no session token", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends host requests with no token header", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { apiFetch, HOST_KEY } = await import("./http");

    await apiFetch(HOST_KEY, { host: "/api/bootstrap/status" });
    await apiFetch(PROJECT, { host: `/api/session/meta?path=${PROJECT}` });

    const sent = fetchMock.mock.calls as unknown as [string, RequestInit][];
    expect(sent.map(([url]) => url)).toEqual([
      "/api/bootstrap/status",
      `/api/session/meta?path=${PROJECT}`,
    ]);
    for (const [, init] of sent) {
      expect(new Headers(init.headers).has("X-Podcast-Token")).toBe(false);
    }
  });

  it("builds media, stream and boundary URLs with no token", async () => {
    const { audioUrl } = await import("./mediaSession");
    const { boundaryAudioUrl } = await import("./boundary");
    const { pipelineEventsUrl } = await import("./pipeline");
    const { bootstrapEventsUrl } = await import("./bootstrap");

    expect([
      audioUrl(PROJECT, "premix"),
      audioUrl(PROJECT, "stem", "host", { cacheKey: "v1" }),
      boundaryAudioUrl("/api/boundary/audio/opaque", "preview-state"),
      pipelineEventsUrl("job-1"),
      bootstrapEventsUrl("job-1"),
    ]).toEqual([
      "/api/audio?path=%2Ftmp%2Fep.project.json&kind=premix",
      "/api/audio?path=%2Ftmp%2Fep.project.json&kind=stem&track_id=host&v=v1",
      "/api/boundary/audio/opaque?expected_token=preview-state",
      "/api/pipeline/events?job_id=job-1",
      "/api/bootstrap/events?job_id=job-1",
    ]);
  });

  it("appends nothing to a socket URL", async () => {
    const { withSessionTokenQuery } = await import("../sessionAuth");

    expect(withSessionTokenQuery("/api/host/ws?path=%2Ftmp")).toBe(
      "/api/host/ws?path=%2Ftmp",
    );
  });
});
