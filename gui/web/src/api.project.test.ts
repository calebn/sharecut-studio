import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadDocumentState,
  loadReviewBootstrap,
  loadReviewVersionStatus,
  reviewVersionAtBootstrap,
} from "./api";

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

  it("remembers the version a review link loaded on and reads its status", async () => {
    const body = {
      capabilities: ["view"],
      meta: {},
      review_version: { id: "v1", label: "Cut 1" },
      link_follows_latest: false,
      newer_version: { id: "v2", label: "Cut 2" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
    );

    expect(reviewVersionAtBootstrap("tok")).toBeNull();
    await loadReviewBootstrap("tok");
    expect(reviewVersionAtBootstrap("tok")).toBe("v1");
    expect(await loadReviewVersionStatus("tok")).toEqual({
      versionId: "v1",
      label: "Cut 1",
      followsLatest: false,
      newer: { id: "v2", label: "Cut 2" },
    });
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
