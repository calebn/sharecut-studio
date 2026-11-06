import { afterEach, describe, expect, it, vi } from "vitest";
import { moveProjectFolder, revealProjectFolder } from "./project";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("revealProjectFolder", () => {
  it("posts the episode path to the host", async () => {
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ revealed: true })),
    );
    vi.stubGlobal("fetch", fetchMock);
    await revealProjectFolder("/tmp/ep/episode.sharecut");
    const target = fetchMock.mock.calls[0]?.[0];
    expect(typeof target === "string" ? target : "").toContain(
      "/api/project/reveal",
    );
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(typeof init?.body === "string" ? init.body : "")).toEqual(
      { path: "/tmp/ep/episode.sharecut" },
    );
  });
});

describe("moveProjectFolder", () => {
  function stub(body: unknown) {
    const fetchMock = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify(body)),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("posts the episode path and answers its new path", async () => {
    const fetchMock = stub({ project_path: "/new/ep/episode.sharecut" });
    await expect(
      moveProjectFolder("/old/ep/episode.sharecut"),
    ).resolves.toEqual({ project_path: "/new/ep/episode.sharecut" });
    const target = fetchMock.mock.calls[0]?.[0];
    expect(typeof target === "string" ? target : "").toContain(
      "/api/project/move",
    );
    const init = fetchMock.mock.calls[0]?.[1];
    expect(JSON.parse(typeof init?.body === "string" ? init.body : "")).toEqual(
      { path: "/old/ep/episode.sharecut" },
    );
  });

  it("passes on a dismissed or missing folder dialog", async () => {
    stub({ cancelled: true });
    await expect(moveProjectFolder("/ep/episode.sharecut")).resolves.toEqual({
      cancelled: true,
    });
    stub({ unavailable: true, detail: "No dialog" });
    await expect(moveProjectFolder("/ep/episode.sharecut")).resolves.toEqual({
      unavailable: true,
      detail: "No dialog",
    });
  });
});
