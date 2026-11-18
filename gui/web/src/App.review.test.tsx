import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { markLinkEnded } from "./api";
import { resetFeaturesCache } from "./extensions/features";
import { urlOf } from "./test/urlOf";

vi.mock("./dawApp", () => ({
  DawApp: () => <div>Cached guest studio</div>,
}));

const offline = vi.hoisted(() => ({
  load: vi.fn(),
  clear: vi.fn(),
}));

const audio = vi.hoisted(() => ({ forget: vi.fn() }));
vi.mock("./audio/chunkCache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./audio/chunkCache")>()),
  forgetLinkAudio: audio.forget,
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
    audio.forget.mockReset().mockResolvedValue(undefined);
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
    expect(audio.forget).toHaveBeenCalledExactlyOnceWith("revoked");
    expect(screen.queryByText("Stale episode")).not.toBeInTheDocument();
  });

  function stubBootstrapFailure(
    response: (url: string) => Response | Promise<Response>,
  ) {
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
        return response(urlOf(input));
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
    expect(audio.forget).not.toHaveBeenCalled();
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

  it("shows the cover when forgetting the audio never settles", async () => {
    window.history.pushState({}, "", "/r/hung-audio");
    audio.forget.mockReturnValue(new Promise(() => {}));
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
    expect(audio.forget).toHaveBeenCalledExactlyOnceWith("hung-audio");
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
    expect(audio.forget).not.toHaveBeenCalled();
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
    // The cover focuses its title in a passive effect, which runs after the
    // heading is found: flush it once, as React does, before asserting.
    await act(async () => {});
    expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();
    expect(screen.getByRole("main")).not.toHaveAttribute("tabindex");
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
      expect(audio.forget).not.toHaveBeenCalled();
      const before = calls;
      fireEvent.click(screen.getByRole("button", { name: "Try now" }));
      await vi.waitFor(() => expect(calls).toBeGreaterThan(before));
    },
  );

  it.each([
    [500, "Try again, and if it keeps happening, tell the person who sent it."],
    [429, "This link is busy right now; this page tries again in a moment."],
  ])(
    "shows This link did not load with Retry and one plain sentence for a %i",
    async (status, sentence) => {
      window.history.pushState({}, "", "/r/failing");
      offline.load.mockResolvedValue(undefined);
      let calls = 0;
      stubBootstrapFailure(() => {
        calls += 1;
        return new Response(JSON.stringify({ detail: "x" }), { status });
      });
      render(<App />);
      const title = await screen.findByRole("heading", {
        level: 1,
        name: "This link did not load",
      });
      // The cover focuses its title in a passive effect, which runs after the
      // heading is found: flush it once, as React does, before asserting.
      await act(async () => {});
      expect(title).toHaveFocus();
      expect(audio.forget).not.toHaveBeenCalled();
      expect(screen.getByRole("main")).not.toHaveAttribute("tabindex");
      expect(screen.getByText(sentence)).toBeVisible();
      const before = calls;
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await vi.waitFor(() => expect(calls).toBeGreaterThan(before));
    },
  );

  it.each([
    [
      "an HTML 500",
      () =>
        new Response("<html><body>Traceback SENTINEL-1</body></html>", {
          status: 500,
          headers: { "Content-Type": "text/html" },
        }),
      "Try again, and if it keeps happening, tell the person who sent it.",
    ],
    [
      "a JSON 500 with a code",
      () =>
        new Response(JSON.stringify({ detail: "SENTINEL-1 internal error" }), {
          status: 500,
          headers: { "X-Sharecut-Error-Code": "internal_error" },
        }),
      "Try again, and if it keeps happening, tell the person who sent it.",
    ],
    [
      "a 401",
      () =>
        new Response(JSON.stringify({ detail: "SENTINEL-1 sign in" }), {
          status: 401,
          headers: { "X-Sharecut-Error-Code": "authentication_required" },
        }),
      "This link needs a sign-in; ask the person who sent it how to sign in.",
    ],
    [
      "a 403",
      () =>
        new Response(JSON.stringify({ detail: "SENTINEL-1 mismatch" }), {
          status: 403,
          headers: { "X-Sharecut-Error-Code": "share_token_mismatch" },
        }),
      "This link is only for certain people; ask the person who sent it to check it was made for you.",
    ],
    [
      "a 404 with another code",
      () =>
        new Response(JSON.stringify({ detail: "SENTINEL-1 missing" }), {
          status: 404,
          headers: { "X-Sharecut-Error-Code": "project_not_found" },
        }),
      "This link isn't available right now; ask the person who sent it to check it.",
    ],
    [
      "a 200 that is not JSON",
      () => new Response("<html>SENTINEL-1 sign in</html>", { status: 200 }),
      "This network did not pass the page through; on public Wi-Fi, sign in to the Wi-Fi first, then try again.",
    ],
  ])(
    "never prints the server's response text, only the table's sentence, for %s",
    async (_name, respond, sentence) => {
      window.history.pushState({}, "", "/r/plain");
      offline.load.mockResolvedValue(undefined);
      stubBootstrapFailure(respond);
      render(<App />);
      await screen.findByRole("heading", { name: "This link did not load" });
      expect(screen.getByText(sentence)).toBeVisible();
      expect(document.body).not.toHaveTextContent("SENTINEL-1");
      expect(audio.forget).not.toHaveBeenCalled();
    },
  );

  it.each([[401], [403]])(
    "offers no button for a %i, because pressing cannot change the answer",
    async (status) => {
      window.history.pushState({}, "", "/r/refused");
      offline.load.mockResolvedValue(undefined);
      stubBootstrapFailure(() => new Response("{}", { status }));
      render(<App />);
      await screen.findByRole("heading", { name: "This link did not load" });
      expect(screen.queryByRole("button")).toBeNull();
      expect(audio.forget).not.toHaveBeenCalled();
    },
  );

  it("does not call a busy host asleep, and retries it every 30 seconds", async () => {
    window.history.pushState({}, "", "/r/busy");
    offline.load.mockResolvedValue(undefined);
    let calls = 0;
    stubBootstrapFailure(() => {
      calls += 1;
      return new Response(
        JSON.stringify({ detail: "This project is busy; try again." }),
        { status: 503, headers: { "X-Sharecut-Error-Code": "project_busy" } },
      );
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<App />);
    await screen.findByRole("heading", { name: "This link did not load" });
    expect(screen.queryByText("The host's computer is asleep")).toBeNull();
    expect(
      screen.getByText(
        "This episode is busy for a moment; this page tries again every 30 seconds.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
    const before = calls;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(31_000);
    });
    await vi.waitFor(() => expect(calls).toBe(before + 1), {
      interval: 0,
      timeout: 200,
    });
  });

  it.each([
    ["10", 10_000],
    [null, 30_000],
    ["1", 5_000],
    ["900", 120_000],
  ])(
    "retries a 429 with Retry-After %s after %i ms",
    async (retryAfter, delay) => {
      window.history.pushState({}, "", "/r/limited");
      offline.load.mockResolvedValue(undefined);
      let calls = 0;
      stubBootstrapFailure(() => {
        calls += 1;
        return new Response("{}", {
          status: 429,
          headers: retryAfter ? { "Retry-After": retryAfter } : {},
        });
      });
      vi.useFakeTimers({ shouldAdvanceTime: true });
      render(<App />);
      await screen.findByRole("heading", { name: "This link did not load" });
      const before = calls;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay - 1_000);
      });
      expect(calls).toBe(before);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
      await vi.waitFor(() => expect(calls).toBe(before + 1), {
        interval: 0,
        timeout: 200,
      });
    },
  );

  it("never retries a 500 on its own", async () => {
    window.history.pushState({}, "", "/r/steady");
    offline.load.mockResolvedValue(undefined);
    let calls = 0;
    stubBootstrapFailure(() => {
      calls += 1;
      return new Response("{}", { status: 500 });
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<App />);
    await screen.findByRole("heading", { name: "This link did not load" });
    const before = calls;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000);
    });
    expect(calls).toBe(before);
  });

  it("answers a press on the cover, keeps focus on the button, and says it failed again", async () => {
    window.history.pushState({}, "", "/r/press");
    offline.load.mockResolvedValue(undefined);
    let calls = 0;
    stubBootstrapFailure(() => {
      calls += 1;
      throw new TypeError("Failed to fetch");
    });
    render(<App />);
    const button = await screen.findByRole("button", { name: "Try now" });
    expect(screen.getByRole("status")).toHaveTextContent("");
    button.focus();
    const before = calls;
    fireEvent.click(button);
    expect(screen.getByRole("button", { name: "Trying…" })).toBe(button);
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Trying again…");
    await vi.waitFor(() => expect(calls).toBeGreaterThan(before));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Still asleep."),
    );
    expect(screen.getByRole("button", { name: "Try now" })).toBe(button);
    expect(button).toHaveFocus();
  });

  it("says This address cannot open review links when the host has no share routes", async () => {
    window.history.pushState({}, "", "/r/noroutes");
    resetFeaturesCache();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ api_version: 1, features: [] }), {
            status: 200,
          }),
      ),
    );
    render(<App />);
    await screen.findByRole("heading", { name: "This link did not load" });
    expect(
      screen.getByText(
        "This address cannot open review links; ask the person who sent it to check the link.",
      ),
    ).toBeVisible();
    expect(screen.queryByRole("button")).toBeNull();
  });

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

  describe("a guest whose device reports no connection", () => {
    let deviceOnline = true;
    let hostUp = false;
    let hostStatus: number | null = null;

    const comesBack = () => {
      deviceOnline = true;
      act(() => void window.dispatchEvent(new Event("online")));
    };

    let projectUrls: string[] = [];
    let gate: Promise<void> | null = null;
    const holdAttempts = () => {
      let release: () => void = () => {};
      gate = new Promise<void>((resolve) => {
        release = () => {
          gate = null;
          resolve();
        };
      });
      return release;
    };

    beforeEach(() => {
      deviceOnline = false;
      hostUp = false;
      hostStatus = null;
      projectUrls = [];
      gate = null;
      vi.spyOn(navigator, "onLine", "get").mockImplementation(
        () => deviceOnline,
      );
      offline.load.mockResolvedValue(undefined);
      stubBootstrapFailure(async (url) => {
        projectUrls.push(url);
        if (gate) await gate;
        if (hostUp) {
          return new Response(
            JSON.stringify({
              capabilities: ["view"],
              meta: { name: "Episode" },
            }),
            { status: 200 },
          );
        }
        if (hostStatus !== null) {
          return new Response("{}", { status: hostStatus });
        }
        throw new TypeError("Failed to fetch");
      });
      window.history.pushState({}, "", "/r/nolink");
    });

    const offlineCover = () =>
      screen.findByRole("heading", { name: "You're offline" });
    const asleepCover = () =>
      screen.findByRole("heading", { name: "The host's computer is asleep" });

    it("is told so, with the page's words, when the first load fails", async () => {
      render(<App />);
      const cover = await offlineCover();
      // The cover focuses its title in a passive effect, which runs after the
      // heading is found: flush it once, as React does, before asserting.
      await act(async () => {});
      expect(cover).toHaveFocus();
      expect(
        screen.getByText(
          "This page opens the episode by itself when your connection is back.",
        ),
      ).toBeVisible();
      expect(screen.getByRole("button", { name: "Try now" })).toBeVisible();
      expect(screen.queryByText(/asleep/)).toBeNull();
    });

    it("is told the host is asleep when the browser says the device is online", async () => {
      deviceOnline = true;
      render(<App />);
      await asleepCover();
      expect(screen.queryByText("You're offline")).toBeNull();
    });

    it("opens the episode by itself when the connection is back, without a press", async () => {
      render(<App />);
      await offlineCover();
      const before = projectUrls.length;
      hostUp = true;
      comesBack();
      expect(
        await screen.findByText("Cached guest studio"),
      ).toBeInTheDocument();
      expect(projectUrls.length).toBe(before + 1);
    });

    it("says the host is asleep, never offline, when the connection is back and the host is down", async () => {
      render(<App />);
      await offlineCover();
      hostStatus = 503;
      comesBack();
      await asleepCover();
      expect(screen.queryByText("You're offline")).toBeNull();
    });

    it("tries again once the saved-copy read finishes when the connection came back during it", async () => {
      let finishRead: (value: undefined) => void = () => {};
      offline.load.mockReturnValue(
        new Promise<undefined>((resolve) => {
          finishRead = resolve;
        }),
      );
      render(<App />);
      await vi.waitFor(() => expect(offline.load).toHaveBeenCalled());
      hostUp = true;
      comesBack();
      const before = projectUrls.length;
      await act(async () => finishRead(undefined));
      expect(
        await screen.findByText("Cached guest studio"),
      ).toBeInTheDocument();
      expect(projectUrls.length).toBe(before + 1);
    });

    it("starts one attempt for two events that arrive while it runs", async () => {
      render(<App />);
      await offlineCover();
      const before = projectUrls.length;
      comesBack();
      comesBack();
      await asleepCover().catch(() => undefined);
      await vi.waitFor(() => expect(projectUrls.length).toBe(before + 1));
    });

    it("moves from asleep to offline only when a retry fails with the device offline, never on the offline event", async () => {
      deviceOnline = true;
      vi.useFakeTimers({ shouldAdvanceTime: true });
      render(<App />);
      await asleepCover();
      deviceOnline = false;
      act(() => void window.dispatchEvent(new Event("offline")));
      expect(screen.queryByText("You're offline")).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000);
      });
      expect(await offlineCover()).toBeInTheDocument();
    });

    it("moves from offline to asleep when the 30 second retry fails with the device online", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      render(<App />);
      await offlineCover();
      deviceOnline = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000);
      });
      expect(await asleepCover()).toBeInTheDocument();
    });

    it("answers Try now on the offline cover with Still offline.", async () => {
      render(<App />);
      await offlineCover();
      fireEvent.click(screen.getByRole("button", { name: "Try now" }));
      expect(await screen.findByText("Still offline.")).toBeInTheDocument();
    });

    const settle = () => act(async () => {});

    it("starts no attempt when the connection returns on the asleep cover", async () => {
      deviceOnline = true;
      render(<App />);
      await asleepCover();
      const before = projectUrls.length;
      comesBack();
      await settle();
      expect(projectUrls.length).toBe(before);
      expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
        "The host's computer is asleep",
      );
    });

    it("reads an event that came during an attempt as asleep when the attempt then fails with the browser online, and the 30 second retry still runs", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      render(<App />);
      await offlineCover();
      const before = projectUrls.length;
      const release = holdAttempts();
      fireEvent.click(screen.getByRole("button", { name: "Try now" }));
      await vi.waitFor(() => expect(projectUrls.length).toBe(before + 1));
      comesBack();
      release();
      await asleepCover();
      expect(projectUrls.length).toBe(before + 1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000);
      });
      await vi.waitFor(() => expect(projectUrls.length).toBe(before + 2));
    });

    it("keeps the offline cover and starts nothing extra when an attempt that met an online event fails offline again, and the next event retries once", async () => {
      render(<App />);
      await offlineCover();
      const before = projectUrls.length;
      const release = holdAttempts();
      fireEvent.click(screen.getByRole("button", { name: "Try now" }));
      await vi.waitFor(() => expect(projectUrls.length).toBe(before + 1));
      act(() => void window.dispatchEvent(new Event("online")));
      release();
      await settle();
      await vi.waitFor(() =>
        expect(screen.getByText("Still offline.")).toBeInTheDocument(),
      );
      expect(projectUrls.length).toBe(before + 1);
      hostUp = true;
      comesBack();
      expect(
        await screen.findByText("Cached guest studio"),
      ).toBeInTheDocument();
      expect(projectUrls.length).toBe(before + 2);
    });

    it("starts no bootstrap on a later online event once the episode is open", async () => {
      render(<App />);
      await offlineCover();
      hostUp = true;
      fireEvent.click(screen.getByRole("button", { name: "Try now" }));
      await screen.findByText("Cached guest studio");
      const before = projectUrls.length;
      comesBack();
      comesBack();
      await settle();
      expect(projectUrls.length).toBe(before);
    });

    it("starts nothing for the old link when the link changed while the offline cover was up", async () => {
      const { rerender } = render(<App />);
      await offlineCover();
      window.history.pushState({}, "", "/r/other");
      rerender(<App />);
      await vi.waitFor(() =>
        expect(projectUrls.some((u) => u.includes("/other/"))).toBe(true),
      );
      await settle();
      hostUp = true;
      const before = projectUrls.length;
      comesBack();
      await screen.findByText("Cached guest studio");
      expect(
        projectUrls.slice(before).every((u) => u.includes("/other/")),
      ).toBe(true);
    });

    it("starts nothing when the link was ended while the offline cover was up", async () => {
      window.history.pushState({}, "", "/r/ended-offline-link");
      render(<App />);
      await offlineCover();
      markLinkEnded("ended-offline-link");
      const before = projectUrls.length;
      comesBack();
      await settle();
      expect(projectUrls.length).toBe(before);
    });

    it("sends one request when the 30 second timer and the online event come in the same moment", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      render(<App />);
      await offlineCover();
      const before = projectUrls.length;
      deviceOnline = true;
      await act(async () => {
        window.dispatchEvent(new Event("online"));
        await vi.advanceTimersByTimeAsync(31_000);
      });
      await settle();
      expect(projectUrls.length).toBe(before + 1);
    });

    it("sends one request when Try now and the online event come in the same moment", async () => {
      render(<App />);
      await offlineCover();
      const before = projectUrls.length;
      deviceOnline = true;
      act(() => {
        fireEvent.click(screen.getByRole("button", { name: "Try now" }));
        window.dispatchEvent(new Event("online"));
      });
      await settle();
      await vi.waitFor(() =>
        expect(projectUrls.length).toBeGreaterThan(before),
      );
      await settle();
      expect(projectUrls.length).toBe(before + 1);
    });

    it("opens the saved copy instead of the cover", async () => {
      offline.load.mockResolvedValue({
        project: { meta: { name: "Stale episode" } },
        saved_at: 1,
      });
      render(<App />);
      expect(
        await screen.findByText("Cached guest studio"),
      ).toBeInTheDocument();
      expect(screen.queryByText("You're offline")).toBeNull();
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
    vi.useRealTimers();
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
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading the episode…",
    );
    expect(container.querySelector(".loading-screen")).toBeNull();
  });

  it("asks for the features again when Retry is pressed after the first ask never answered", async () => {
    window.history.pushState({}, "", "/r/hung");
    resetFeaturesCache();
    offline.load.mockResolvedValue(undefined);
    let asked = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (urlOf(input).includes("/features")) {
          asked += 1;
          return asked === 1
            ? new Promise<Response>(() => {})
            : new Response(
                JSON.stringify({
                  api_version: 1,
                  features: ["share.ui.routes"],
                }),
                { status: 200 },
              );
        }
        return new Response("{}", { status: 500 });
      }),
    );
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<App />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(asked).toBe(2);
    expect(
      await screen.findByRole("heading", { name: "This link did not load" }),
    ).toBeInTheDocument();
  });

  it("leaves the loading screen when the first features call answers after Retry, without waiting for the second", async () => {
    window.history.pushState({}, "", "/r/slow");
    resetFeaturesCache();
    offline.load.mockResolvedValue(undefined);
    const answers: Array<(res: Response) => void> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (urlOf(input).includes("/features")) {
          return new Promise<Response>((resolve) => answers.push(resolve));
        }
        return new Response("{}", { status: 500 });
      }),
    );
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<App />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(answers).toHaveLength(2);
    await act(async () => {
      answers[0]?.(
        new Response(
          JSON.stringify({ api_version: 1, features: ["share.ui.routes"] }),
          { status: 200 },
        ),
      );
    });
    expect(
      await screen.findByRole("heading", { name: "This link did not load" }),
    ).toBeInTheDocument();
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
