import { afterEach, describe, expect, it, vi } from "vitest";
import { revealProjectFolder } from "./project";

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
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      "/api/project/reveal",
    );
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(typeof init?.body === "string" ? init.body : "")).toEqual(
      { path: "/tmp/ep/episode.sharecut" },
    );
  });
});
