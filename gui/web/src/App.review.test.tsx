import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { resetFeaturesCache } from "./extensions/features";
import { urlOf } from "./test/urlOf";

vi.mock("./dawApp", () => ({
  DawApp: () => <div>Cached guest studio</div>,
}));

const offline = vi.hoisted(() => ({
  load: vi.fn(),
  clear: vi.fn(),
}));

vi.mock("./services/offlineQueue/offlineStore", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("./services/offlineQueue/offlineStore")
  >()),
  loadOfflineSnapshot: offline.load,
  clearOfflineSnapshot: offline.clear,
}));

describe("App review route", () => {
  beforeEach(() => {
    offline.load.mockReset();
    offline.clear.mockReset();
    offline.clear.mockResolvedValue(undefined);
    resetFeaturesCache();
    window.history.pushState({}, "", "/r/no-view");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.pushState({}, "", "/");
    resetFeaturesCache();
  });

  it("refuses a share without view instead of opening a listen page", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.includes("/features")) {
        return new Response(
          JSON.stringify({
            api_version: 1,
            features: ["share.ui.routes", "share.ui.banner", "share.ui.menu"],
          }),
          { status: 200 },
        );
      }
      if (url.endsWith("/api/review/no-view/project")) {
        return new Response(
          JSON.stringify({
            capabilities: ["play", "comment"],
            guest_mode: "comment",
            meta: { name: "Episode" },
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    expect(
      await screen.findByText("This link does not open the project."),
    ).toBeInTheDocument();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("This link does not open the project.");
    expect(alert).toHaveTextContent(
      "Ask the person who shared it for a new link.",
    );
    expect(
      fetchMock.mock.calls.some((call) =>
        urlOf(call[0] as RequestInfo | URL).endsWith("/audio"),
      ),
    ).toBe(false);
  });

  it("tells a guest with a dead link to ask the host for a new one", async () => {
    window.history.pushState({}, "", "/r/gone");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.includes("/features")) {
          return new Response(
            JSON.stringify({
              api_version: 1,
              features: ["share.ui.routes", "share.ui.banner", "share.ui.menu"],
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({ detail: "invalid or revoked share token" }),
          {
            status: 404,
            headers: { "X-Sharecut-Error-Code": "share_not_found" },
          },
        );
      }),
    );
    render(<App />);
    expect(
      await screen.findByText("This link is invalid or has ended."),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Ask the host for a new link.",
    );
  });

  it("drops a cached snapshot and shows the cover for a revoked link", async () => {
    window.history.pushState({}, "", "/r/revoked");
    offline.load.mockResolvedValue({
      project: { meta: { name: "Stale episode" } },
      saved_at: 1,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (urlOf(input).includes("/features")) {
          return new Response(
            JSON.stringify({
              api_version: 1,
              features: ["share.ui.routes", "share.ui.banner", "share.ui.menu"],
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({ detail: "invalid or revoked share token" }),
          {
            status: 404,
            headers: { "X-Sharecut-Error-Code": "share_not_found" },
          },
        );
      }),
    );
    render(<App />);
    expect(
      await screen.findByText("This link is invalid or has ended."),
    ).toBeInTheDocument();
    expect(offline.clear).toHaveBeenCalledWith("revoked");
    expect(screen.queryByText("Stale episode")).not.toBeInTheDocument();
  });

  function stubBootstrapFailure(response: () => Response) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (urlOf(input).includes("/features")) {
          return new Response(
            JSON.stringify({
              api_version: 1,
              features: ["share.ui.routes", "share.ui.banner", "share.ui.menu"],
            }),
            { status: 200 },
          );
        }
        return response();
      }),
    );
  }

  it("shows the cover without dropping the snapshot for a 404 with no error code", async () => {
    window.history.pushState({}, "", "/r/stripped");
    offline.load.mockResolvedValue({
      project: { meta: { name: "Stale episode" } },
      saved_at: 1,
    });
    stubBootstrapFailure(
      () =>
        new Response(
          JSON.stringify({ detail: "invalid or revoked share token" }),
          {
            status: 404,
          },
        ),
    );
    render(<App />);
    expect(
      await screen.findByText("This link is invalid or has ended."),
    ).toBeInTheDocument();
    expect(offline.clear).not.toHaveBeenCalled();
  });

  it("shows the cover even when clearing the snapshot never settles", async () => {
    window.history.pushState({}, "", "/r/hung");
    offline.clear.mockReturnValue(new Promise(() => {}));
    stubBootstrapFailure(
      () =>
        new Response(JSON.stringify({ detail: "x" }), {
          status: 404,
          headers: { "X-Sharecut-Error-Code": "share_not_found" },
        }),
    );
    render(<App />);
    expect(
      await screen.findByText("This link is invalid or has ended."),
    ).toBeInTheDocument();
  });

  it("shows the cover when clearing the snapshot rejects", async () => {
    window.history.pushState({}, "", "/r/rejects");
    offline.clear.mockRejectedValue(new Error("idb down"));
    stubBootstrapFailure(
      () =>
        new Response(JSON.stringify({ detail: "x" }), {
          status: 404,
          headers: { "X-Sharecut-Error-Code": "share_not_found" },
        }),
    );
    render(<App />);
    expect(
      await screen.findByText("This link is invalid or has ended."),
    ).toBeInTheDocument();
  });

  it("falls back to the cached snapshot when the server is unreachable", async () => {
    window.history.pushState({}, "", "/r/offline");
    offline.load.mockResolvedValue({
      project: { meta: { name: "Stale episode" } },
      saved_at: 1,
    });
    stubBootstrapFailure(() => {
      throw new TypeError("Failed to fetch");
    });
    render(<App />);
    expect(await screen.findByText("Cached guest studio")).toBeInTheDocument();
    expect(
      screen.queryByText("This link is invalid or has ended."),
    ).not.toBeInTheDocument();
    expect(offline.clear).not.toHaveBeenCalled();
  });

  it.each([
    ["a coded project_not_found 404", 404, "project_not_found"],
    ["a 5xx", 503, null],
  ])("keeps the cached snapshot for %s", async (_name, status, code) => {
    window.history.pushState({}, "", "/r/cached");
    offline.load.mockResolvedValue({
      project: { meta: { name: "Stale episode" } },
      saved_at: 1,
    });
    stubBootstrapFailure(
      () =>
        new Response(JSON.stringify({ detail: "x" }), {
          status,
          headers: code ? { "X-Sharecut-Error-Code": code } : {},
        }),
    );
    render(<App />);
    expect(await screen.findByText("Cached guest studio")).toBeInTheDocument();
    expect(offline.clear).not.toHaveBeenCalled();
  });
});
