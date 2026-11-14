import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRecordBootstrap } from "./recordBootstrap";

const BOOTSTRAP = {
  mode: "record",
  kind: "record",
  token: "rec-tok",
  role: "guest",
  session_id: null,
  capabilities: [],
  episode: { name: "Shot of Truth" },
  room: { recorded_cap: 4, producer_cap: 1 },
  build: { capture: true, monitor: true, upload: true },
  expires_at: null,
};

function stubFetch(response: () => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(response));
}

function reply(status: number, body: string, code?: string) {
  return () =>
    Promise.resolve(
      new Response(body, {
        status,
        headers: code ? { "X-Sharecut-Error-Code": code } : {},
      }),
    );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("loadRecordBootstrap", () => {
  it("types a request that never got an answer as network", async () => {
    stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
    await expect(loadRecordBootstrap("rec-tok")).resolves.toEqual({
      bootstrap: null,
      failure: "network",
    });
  });

  it.each([
    [404, '{"detail":"share not found"}', "share_not_found"],
    [403, '{"detail":"token mismatch"}', "share_token_mismatch"],
    [410, '{"detail":"gone"}', undefined],
  ])("types a refused link as not-found (%i)", async (status, body, code) => {
    stubFetch(reply(status, body, code));
    await expect(loadRecordBootstrap("rec-tok")).resolves.toEqual({
      bootstrap: null,
      failure: "not-found",
    });
  });

  it.each([
    [500, "boom"],
    [503, '{"detail":"host offline"}'],
    [504, "timeout"],
    [429, "slow down"],
    [408, "timeout"],
  ])("types an answer that may change as server (%i)", async (status, body) => {
    stubFetch(reply(status, body));
    await expect(loadRecordBootstrap("rec-tok")).resolves.toEqual({
      bootstrap: null,
      failure: "server",
    });
  });

  it("types a 2xx whose body is not JSON as network", async () => {
    stubFetch(reply(200, "<html>"));
    await expect(loadRecordBootstrap("rec-tok")).resolves.toEqual({
      bootstrap: null,
      failure: "network",
    });
  });

  it("types a 2xx whose body stream breaks as network", async () => {
    stubFetch(() => {
      const body = new ReadableStream({
        start(controller) {
          controller.error(new TypeError("network error"));
        },
      });
      return Promise.resolve(new Response(body, { status: 200 }));
    });
    await expect(loadRecordBootstrap("rec-tok")).resolves.toEqual({
      bootstrap: null,
      failure: "network",
    });
  });

  it("types a 503 whose text says invalid as server, not not-found", async () => {
    stubFetch(reply(503, '{"detail":"invalid token"}'));
    await expect(loadRecordBootstrap("rec-tok")).resolves.toEqual({
      bootstrap: null,
      failure: "server",
    });
  });

  it("returns the bootstrap and no failure on success", async () => {
    stubFetch(reply(200, JSON.stringify(BOOTSTRAP)));
    const outcome = await loadRecordBootstrap("rec-tok");
    expect(outcome.failure).toBeNull();
    expect(outcome.bootstrap?.episode.name).toBe("Shot of Truth");
  });

  it("rethrows an abort", async () => {
    const controller = new AbortController();
    controller.abort();
    stubFetch(() => Promise.reject(new DOMException("Aborted", "AbortError")));
    await expect(
      loadRecordBootstrap("rec-tok", controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
