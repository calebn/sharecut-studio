import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadDocumentState,
  loadReviewBootstrap,
  loadReviewVersionStatus,
  moveProject,
  pickFolder,
  revealProject,
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

  it("posts the project path to the reveal route", async () => {
    const fetchSpy = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ revealed: true }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await revealProject("/tmp/ep/episode.sharecut");

    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe("/api/project/reveal");
    expect(init?.method).toBe("POST");
    expect(typeof init?.body).toBe("string");
    expect(JSON.parse(init?.body as string)).toEqual({
      path: "/tmp/ep/episode.sharecut",
    });
  });

  it("reads the three answers of the folder dialog", async () => {
    const answer = (body: unknown) =>
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
      );
    answer({ folder: "/Users/ada/Archive" });
    expect(await pickFolder()).toEqual({ folder: "/Users/ada/Archive" });
    answer({ cancelled: true });
    expect(await pickFolder()).toEqual({ cancelled: true });
    answer({ unavailable: true, detail: "no dialog" });
    expect(await pickFolder()).toEqual({
      unavailable: true,
      detail: "no dialog",
    });
    answer({});
    await expect(pickFolder()).rejects.toThrow("Unexpected pick-folder");
  });

  it("posts the move with this window's client id only when it has one", async () => {
    const fetchSpy = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            project_path: "/a/ep/episode.sharecut",
            previous_path: "/b",
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await moveProject("/b/ep/episode.sharecut", "/a", "tab-1");
    await moveProject("/b/ep/episode.sharecut", "/a", null);

    const [first, second] = fetchSpy.mock.calls;
    expect(first?.[0]).toBe("/api/project/move");
    expect(JSON.parse(first?.[1]?.body as string)).toEqual({
      path: "/b/ep/episode.sharecut",
      dest_parent: "/a",
      client_id: "tab-1",
    });
    expect(JSON.parse(second?.[1]?.body as string)).toEqual({
      path: "/b/ep/episode.sharecut",
      dest_parent: "/a",
    });
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
