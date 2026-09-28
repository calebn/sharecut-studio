import { afterEach, describe, expect, it, vi } from "vitest";
import { shareProjectKey } from "../shareMode";
import { loadProsodyOverlay } from "./prosody";

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

describe("prosody api", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads the host overlay for a project path", async () => {
    const body = { schema: "prosody_overlay.v1", tracks: [] };
    const fetchMock = stubFetch(Response.json(body));
    await expect(loadProsodyOverlay("/tmp/p.json")).resolves.toEqual(body);
    const url = requestUrl(fetchMock.mock.calls[0]![0]);
    expect(url).toBe("/api/project/prosody?path=%2Ftmp%2Fp.json");
  });

  it("returns null for a share key without calling fetch", async () => {
    const fetchMock = stubFetch(Response.json({ schema: "x", tracks: [] }));
    const key = shareProjectKey("tok");
    await expect(loadProsodyOverlay(key)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns null on a non-ok response", async () => {
    stubFetch(new Response("nope", { status: 500 }));
    await expect(loadProsodyOverlay("/tmp/p.json")).resolves.toBeNull();
  });

  it("returns null for an empty project path", async () => {
    const fetchMock = stubFetch(Response.json({ schema: "x", tracks: [] }));
    await expect(loadProsodyOverlay("")).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
