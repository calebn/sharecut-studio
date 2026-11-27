import { afterEach, describe, expect, it, vi } from "vitest";
import { ACTIVITY_TIMEOUT_MS, fetchHostMcpActivity } from "./hostMcp";

function reply(body: unknown, init?: ResponseInit) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
      ...init,
    }),
  );
}

describe("fetchHostMcpActivity", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reads the activity shape, with the signal and no caching", async () => {
    const spy = reply({
      mounted: true,
      last_request_at: "2026-01-01T00:00:00Z",
      age_seconds: 12.5,
    });
    const controller = new AbortController();
    await expect(fetchHostMcpActivity(controller.signal)).resolves.toEqual({
      mounted: true,
      last_request_at: "2026-01-01T00:00:00Z",
      age_seconds: 12.5,
    });
    const [url, init] = spy.mock.calls[0]!;
    expect(url as string).toContain("/api/host-mcp/activity");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.cache).toBe("no-store");
  });

  it("accepts never used", async () => {
    reply({ mounted: true, last_request_at: null, age_seconds: null });
    await expect(fetchHostMcpActivity()).resolves.toEqual({
      mounted: true,
      last_request_at: null,
      age_seconds: null,
    });
  });

  it.each([
    ["missing mounted", { last_request_at: null, age_seconds: null }],
    ["string mounted", { mounted: "yes", age_seconds: null }],
    ["negative age", { mounted: true, age_seconds: -1 }],
    ["string age", { mounted: true, age_seconds: "5" }],
    ["array body", []],
    ["null body", null],
  ])("rejects %s", async (_name, body) => {
    reply(body);
    await expect(fetchHostMcpActivity()).rejects.toThrow();
  });

  it("rejects an HTML page from a proxy", async () => {
    reply("<html>sign in</html>", { headers: { "Content-Type": "text/html" } });
    await expect(fetchHostMcpActivity()).rejects.toThrow();
  });

  it("throws the host's refusal with its status", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 403 }),
    );
    await expect(fetchHostMcpActivity()).rejects.toMatchObject({ status: 403 });
  });

  function hangUntilAborted() {
    return vi.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason),
          );
        }),
    );
  }

  it("times out a read the host never answers", async () => {
    vi.useFakeTimers();
    hangUntilAborted();
    const read = expect(fetchHostMcpActivity()).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await vi.advanceTimersByTimeAsync(ACTIVITY_TIMEOUT_MS);
    await read;
  });

  it("lets the caller cancel at once, without waiting for the timeout", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const spy = hangUntilAborted();
    const read = expect(
      fetchHostMcpActivity(controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    const fetchSignal = spy.mock.calls[0]?.[1]?.signal;
    expect(fetchSignal?.aborted).toBe(false);
    controller.abort();
    expect(fetchSignal?.aborted).toBe(true);
    await read;
  });

  it("keeps the body read under the timeout", async () => {
    vi.useFakeTimers();
    // Like a real body stream, json() rejects once the request's signal aborts.
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "Content-Type": "application/json" }),
        json: () =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(init.signal?.reason),
            );
          }),
      } as unknown as Response;
    });
    const read = expect(fetchHostMcpActivity()).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await vi.advanceTimersByTimeAsync(ACTIVITY_TIMEOUT_MS);
    await read;
  });
});
