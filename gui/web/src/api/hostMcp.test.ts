import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchHostMcpActivity } from "./hostMcp";

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
  afterEach(() => vi.restoreAllMocks());

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
    expect(init?.signal).toBe(controller.signal);
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
});
