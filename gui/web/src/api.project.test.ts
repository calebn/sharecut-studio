import { afterEach, describe, expect, it, vi } from "vitest";
import { loadProject, loadProjectDetail } from "./api";

describe("project API facade", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requests host shell and detail phases for the same encoded project", async () => {
    const fetchSpy = vi.fn(
      async (_url: string) =>
        new Response(JSON.stringify({ meta: { name: "Episode" } }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await loadProject("/tmp/episode one.project.json");
    await loadProjectDetail("/tmp/episode one.project.json");

    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
      "/api/project?path=%2Ftmp%2Fepisode%20one.project.json&phase=shell",
      "/api/project?path=%2Ftmp%2Fepisode%20one.project.json&phase=detail",
    ]);
  });

  it("routes a share project through the guest endpoint", async () => {
    const fetchSpy = vi.fn(
      async (_url: string) =>
        new Response(JSON.stringify({ meta: { name: "Shared" } }), {
          status: 200,
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await loadProject("share:guest-token");

    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "/api/review/guest-token/daw/project?phase=shell",
    );
  });
});
