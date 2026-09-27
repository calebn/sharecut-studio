import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("getSessionToken", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("caches the first read for the page (useDocumentSync terminal 4403 relies on this)", async () => {
    window.history.replaceState(null, "", "/?session_token=first");
    const { getSessionToken } = await import("./sessionAuth");
    expect(getSessionToken()).toBe("first");
    window.history.replaceState(null, "", "/?session_token=second");
    expect(getSessionToken()).toBe("first");
  });

  it("returns null without a session_token query", async () => {
    window.history.replaceState(null, "", "/");
    const { getSessionToken } = await import("./sessionAuth");
    expect(getSessionToken()).toBeNull();
  });
});
