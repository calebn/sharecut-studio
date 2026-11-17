import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { resetFeaturesCache } from "./extensions/features";
import { urlOf } from "./test/urlOf";

// The studio chunk never arrives, so the lazy `DawApp` Suspense fallback stays up.
vi.mock("./dawApp", () => new Promise(() => {}));
vi.mock("./record/GuestRoomApp", () => new Promise(() => {}));

const offline = vi.hoisted(() => ({ load: vi.fn(), clear: vi.fn() }));

vi.mock("./services/offlineQueue/offlineStore", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("./services/offlineQueue/offlineStore")
  >()),
  loadOfflineSnapshot: offline.load,
  clearOfflineSnapshot: offline.clear,
}));

const expectGuestSkeleton = (container: HTMLElement) => {
  expect(container.querySelector("main.guest-loading")).not.toBeNull();
  expect(screen.queryAllByRole("tab")).toHaveLength(0);
  expect(container.querySelector(".stage-loading-blank")).toBeNull();
};

describe("guest loading never shows host chrome", () => {
  beforeEach(() => {
    offline.load.mockReset();
    offline.clear.mockReset();
    resetFeaturesCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.pushState({}, "", "/");
    resetFeaturesCache();
  });

  it("shows a record-link guest room wording while the room code loads", () => {
    window.history.pushState({}, "", "/rec/rec-tok");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    const { container } = render(<App />);
    expect(screen.getByRole("status")).toHaveTextContent("Joining the room…");
    expect(screen.queryByText("Loading project…")).toBeNull();
    expect(screen.queryByText("Loading studio…")).toBeNull();
    expectGuestSkeleton(container);
  });

  it("shows a direct share-project query the guest skeleton while features load", async () => {
    vi.useFakeTimers();
    window.history.pushState({}, "", "/?project=share:direct-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    const { container } = render(<App />);
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expectGuestSkeleton(container);
  });

  it("keeps host loading chrome for an ordinary project query", async () => {
    vi.useFakeTimers();
    window.history.pushState({}, "", "/?project=/tmp/host.sharecut");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    const { container } = render(<App />);
    await act(async () => {
      vi.advanceTimersByTime(350);
    });
    expect(container.querySelector(".stage-loading-stages")).not.toBeNull();
    expect(container.querySelector("main.guest-loading")).toBeNull();
  });

  it("shows a cached-snapshot guest the guest skeleton while the studio loads", async () => {
    window.history.pushState({}, "", "/r/offline");
    offline.load.mockResolvedValue({
      project: { meta: { name: "Stale episode" } },
      saved_at: 1,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.includes("/features")) {
          return new Response(
            JSON.stringify({
              api_version: 1,
              features: ["share.ui.routes"],
            }),
            { status: 200 },
          );
        }
        throw new TypeError("Failed to fetch");
      }),
    );
    const { container } = render(<App />);
    await vi.waitFor(() => {
      expect(offline.load).toHaveBeenCalled();
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Loading Stale episode…",
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Stale episode",
    );
    expectGuestSkeleton(container);
  });

  it("names the episode from the link's own answer while the studio loads, and never says project", async () => {
    window.history.pushState({}, "", "/r/named");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.includes("/features")) {
          return new Response(
            JSON.stringify({ api_version: 1, features: ["share.ui.routes"] }),
            { status: 200 },
          );
        }
        if (url.endsWith("/api/review/named/project")) {
          return new Response(
            JSON.stringify({
              capabilities: ["view", "comment"],
              guest_mode: "comment",
              reads_transcript_words: false,
              meta: { name: "Pilot episode" },
            }),
            { status: 200 },
          );
        }
        throw new TypeError("Failed to fetch");
      }),
    );
    const { container } = render(<App />);
    await vi.waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "Loading Pilot episode…",
      );
    });
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(
      "Pilot episode",
    );
    expect(container.textContent?.toLowerCase()).not.toContain("project");
    expectGuestSkeleton(container);
  });

  const answerProject = (project: Response) =>
    vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.includes("/features")) {
        return new Response(
          JSON.stringify({ api_version: 1, features: ["share.ui.routes"] }),
          { status: 200 },
        );
      }
      if (url.endsWith("/project")) return project.clone();
      throw new TypeError("Failed to fetch");
    });
  const projectAnswer = (name: unknown) =>
    new Response(
      JSON.stringify({
        capabilities: ["view", "comment"],
        guest_mode: "comment",
        reads_transcript_words: false,
        meta: { name },
      }),
      { status: 200 },
    );

  it("trims the name the link answers with", async () => {
    window.history.pushState({}, "", "/r/padded");
    vi.stubGlobal("fetch", answerProject(projectAnswer("  Pilot episode \n")));
    render(<App />);
    await vi.waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        /^Loading Pilot episode…$/,
      );
    });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Pilot episode",
    );
  });

  it("takes a name of only spaces, or one that is not text, for no name", async () => {
    window.history.pushState({}, "", "/r/blank");
    vi.stubGlobal("fetch", answerProject(projectAnswer("   ")));
    const blank = render(<App />);
    await vi.waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "Loading the episode…",
      );
    });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Episode",
    );
    blank.unmount();
    vi.stubGlobal("fetch", answerProject(projectAnswer({ not: "text" })));
    resetFeaturesCache();
    render(<App />);
    await vi.waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent(
        "Loading the episode…",
      );
    });
  });

  it("shows no name for a link the server no longer knows, even with a saved copy that has one", async () => {
    window.history.pushState({}, "", "/r/off");
    offline.clear.mockResolvedValue(undefined);
    offline.load.mockResolvedValue({
      project: { meta: { name: "Stale episode" } },
      saved_at: 1,
    });
    vi.stubGlobal(
      "fetch",
      answerProject(
        new Response(JSON.stringify({ detail: "No such share." }), {
          status: 404,
          headers: { "X-Sharecut-Error-Code": "share_not_found" },
        }),
      ),
    );
    const { container } = render(<App />);
    await vi.waitFor(() => {
      expect(container.querySelector("main.guest-loading")).toBeNull();
    });
    expect(container.textContent).not.toContain("Stale episode");
    expect(screen.queryByText(/Loading .*…/)).toBeNull();
  });
});
