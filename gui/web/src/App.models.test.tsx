import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { resetFeaturesCache } from "./extensions/features";
import { urlOf } from "./test/urlOf";

function stubFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = urlOf(input);
    if (url.includes("/features")) {
      return new Response(
        JSON.stringify({ api_version: 1, features: ["share.ui.routes"] }),
        { status: 200 },
      );
    }
    if (url.includes("/api/bootstrap/status-job")) {
      return new Response(JSON.stringify({ job: null }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return (path: string) =>
    fetchMock.mock.calls.filter((call) =>
      urlOf(call[0] as RequestInfo | URL).includes(path),
    ).length;
}

describe("App models provider", () => {
  beforeEach(() => {
    resetFeaturesCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.pushState({}, "", "/");
    resetFeaturesCache();
  });

  it("mounts exactly one models provider on the host", async () => {
    window.history.pushState({}, "", "/");
    const calls = stubFetch();
    render(<App />);
    await waitFor(() => expect(calls("/api/bootstrap/status-job")).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls("/api/bootstrap/status-job")).toBe(1);
  });

  it("does not ask a share guest for host model status", async () => {
    window.history.pushState({}, "", "/r/some-token");
    const calls = stubFetch();
    render(<App />);
    await waitFor(() => expect(calls("/features")).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls("/api/bootstrap")).toBe(0);
  });
});
