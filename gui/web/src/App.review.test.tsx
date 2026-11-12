import { act, fireEvent, render, screen } from "@testing-library/react";
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
    vi.useRealTimers();
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
            reads_transcript_words: true,
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
      await screen.findByText("This link doesn't open anything"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", {
        name: "This link doesn't open anything",
      }),
    ).toHaveTextContent("Ask the person who sent it for a new link.");
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
      await screen.findByText("This link doesn't open anything"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("region", {
        name: "This link doesn't open anything",
      }),
    ).toHaveTextContent("Ask the person who sent it for a new link.");
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
      await screen.findByText("This link doesn't open anything"),
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
      await screen.findByText("This link doesn't open anything"),
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
      await screen.findByText("This link doesn't open anything"),
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
      await screen.findByText("This link doesn't open anything"),
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
      screen.queryByText("This link doesn't open anything"),
    ).not.toBeInTheDocument();
    expect(offline.clear).not.toHaveBeenCalled();
  });

  it("shows a Try now cover for an unreachable host with no saved copy", async () => {
    window.history.pushState({}, "", "/r/asleep");
    offline.load.mockResolvedValue(undefined);
    let reachable = false;
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
        if (!reachable) {
          throw new TypeError("Failed to fetch");
        }
        return new Response(
          JSON.stringify({ capabilities: ["view"], meta: { name: "Episode" } }),
          { status: 200 },
        );
      }),
    );
    render(<App />);
    expect(
      await screen.findByRole("heading", {
        name: "The host's computer is asleep",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("This page tries again every 30 seconds."),
    ).toBeVisible();
    expect(screen.getByRole("main")).toHaveFocus();
    reachable = true;
    fireEvent.click(screen.getByRole("button", { name: "Try now" }));
    expect(await screen.findByText("Cached guest studio")).toBeInTheDocument();
  });

  it.each([
    [503, "host offline"],
    [504, "host timed out"],
  ])(
    "treats a relay %i as an asleep host and Try now retries",
    async (status, detail) => {
      window.history.pushState({}, "", "/r/relay");
      offline.load.mockResolvedValue(undefined);
      let calls = 0;
      stubBootstrapFailure(() => {
        calls += 1;
        return new Response(JSON.stringify({ detail }), { status });
      });
      render(<App />);
      expect(
        await screen.findByRole("heading", {
          name: "The host's computer is asleep",
        }),
      ).toBeInTheDocument();
      const before = calls;
      fireEvent.click(screen.getByRole("button", { name: "Try now" }));
      await vi.waitFor(() => expect(calls).toBeGreaterThan(before));
    },
  );

  it.each([[500], [429]])(
    "shows This link did not load with Retry for a %i",
    async (status) => {
      window.history.pushState({}, "", "/r/failing");
      offline.load.mockResolvedValue(undefined);
      let calls = 0;
      stubBootstrapFailure(() => {
        calls += 1;
        return new Response(JSON.stringify({ detail: "x" }), { status });
      });
      render(<App />);
      expect(
        await screen.findByRole("heading", { name: "This link did not load" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("main")).toHaveFocus();
      const before = calls;
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await vi.waitFor(() => expect(calls).toBeGreaterThan(before));
    },
  );

  it("retries an asleep host on its own every 30 seconds", async () => {
    window.history.pushState({}, "", "/r/auto");
    offline.load.mockResolvedValue(undefined);
    let calls = 0;
    stubBootstrapFailure(() => {
      calls += 1;
      return new Response(JSON.stringify({ detail: "host offline" }), {
        status: 503,
      });
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<App />);
    await screen.findByRole("heading", {
      name: "The host's computer is asleep",
    });
    const before = calls;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_000);
    });
    expect(calls).toBe(before);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await vi.waitFor(() => expect(calls).toBe(before + 1), {
      interval: 0,
      timeout: 200,
    });
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

describe("App loading screens before the features answer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.history.pushState({}, "", "/");
    resetFeaturesCache();
  });

  const stall = () => {
    resetFeaturesCache();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
  };

  it("shows a review-link guest the guest skeleton screen", () => {
    window.history.pushState({}, "", "/r/pending");
    stall();
    const { container } = render(<App />);
    expect(container.querySelector("main.guest-loading")).not.toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Loading project…");
    expect(container.querySelector(".loading-screen")).toBeNull();
  });

  it("shows the host the Loading cover, not the plain loading screen", () => {
    window.history.pushState({}, "", "/");
    stall();
    const { container } = render(<App />);
    expect(container.querySelector("main.guest-loading")).toBeNull();
    expect(container.querySelector(".loading-screen")).toBeNull();
    expect(container.querySelector(".stage-loading-blank")).not.toBeNull();
  });
});
