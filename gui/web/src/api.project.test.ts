import { afterEach, describe, expect, it, vi } from "vitest";
import { loadDocumentState } from "./api";

describe("project API facade", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requests host shell and detail phases for the same encoded project", async () => {
    const fetchSpy = vi.fn(
      async (_url: string) =>
        new Response(
          JSON.stringify({
            server_seq: 4,
            state_token: "a".repeat(64),
            project: { meta: { name: "Episode" } },
          }),
          {
            status: 200,
          },
        ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await loadDocumentState("/tmp/episode one.project.json");
    await loadDocumentState("/tmp/episode one.project.json", "detail");

    expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
      "/api/document/state?path=%2Ftmp%2Fepisode%20one.project.json&phase=shell",
      "/api/document/state?path=%2Ftmp%2Fepisode%20one.project.json&phase=detail",
    ]);
  });

  it("routes a share project through the guest endpoint", async () => {
    const fetchSpy = vi.fn(
      async (_url: string) =>
        new Response(
          JSON.stringify({
            server_seq: 4,
            state_token: "a".repeat(64),
            project: { meta: { name: "Shared" } },
          }),
          {
            status: 200,
          },
        ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await loadDocumentState("share:guest-token");

    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "/api/review/guest-token/daw/document/state?phase=shell",
    );
  });
});
