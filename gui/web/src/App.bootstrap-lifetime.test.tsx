import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { resetFeaturesCache } from "./extensions/features";
import { minimalProject } from "./test/fixtures";
import { urlOf } from "./test/urlOf";
import type { ProjectView } from "./types/project";

vi.mock("./dawApp", () => ({ DawApp: () => <p>Studio body</p> }));
vi.mock("./models", () => ({
  ModelsProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./state/store", () => ({
  DawProvider: ({
    children,
    projectPath,
    initialProject,
    shareAuthor,
    shareTranscriptWords,
  }: {
    children: ReactNode;
    projectPath: string;
    initialProject: ProjectView | null;
    shareAuthor?: string | null;
    shareTranscriptWords?: boolean;
  }) => (
    <section
      aria-label="Bootstrap provider"
      data-path={projectPath}
      data-cached-name={initialProject?.meta.name ?? ""}
      data-author={shareAuthor ?? ""}
      data-transcript-words={String(shareTranscriptWords)}
    >
      {children}
    </section>
  ),
}));
const offline = vi.hoisted(() => ({ load: vi.fn(), clear: vi.fn() }));
vi.mock("./services/offlineQueue/offlineStore", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("./services/offlineQueue/offlineStore")
  >()),
  loadOfflineSnapshot: offline.load,
  clearOfflineSnapshot: offline.clear,
}));

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function bootstrap(author: string, flag: boolean | "absent" = true) {
  return new Response(
    JSON.stringify({
      capabilities: ["view", "comment"],
      guest_mode: "comment",
      reads_transcript_words: flag === "absent" ? undefined : flag,
      author,
      meta: { name: author },
    }),
    { status: 200 },
  );
}

function serve(load: (token: string) => Promise<Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = urlOf(input);
    if (url.includes("/features")) {
      return new Response(
        JSON.stringify({ api_version: 1, features: ["share.ui.routes"] }),
        { status: 200 },
      );
    }
    const token = url.match(/\/api\/review\/([^/]+)\/project$/)?.[1];
    return token ? load(token) : new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const provider = () =>
  screen.getByRole("region", { name: "Bootstrap provider" });
function cachedProject() {
  const project = minimalProject();
  return { ...project, meta: { ...project.meta, name: "Alpha cached" } };
}

describe("App bootstrap request lifetime", () => {
  beforeEach(() => {
    resetFeaturesCache();
    offline.load.mockReset();
    offline.clear.mockReset();
    offline.clear.mockResolvedValue(undefined);
    window.history.pushState({}, "", "/r/alpha");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    window.history.pushState({}, "", "/");
    resetFeaturesCache();
  });

  it.each([false, true])(
    "rejects old bootstrap completion after a different review wins, refusal=%s",
    async (refusal) => {
      const old = deferred<Response>();
      const fetchMock = serve((token) =>
        token === "alpha" ? old.promise : Promise.resolve(bootstrap("Beta")),
      );
      const { rerender } = render(<App />);
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(([input]) =>
            urlOf(input).endsWith("/api/review/alpha/project"),
          ),
        ).toBe(true),
      );
      window.history.pushState({}, "", "/r/beta");
      rerender(<App />);
      await screen.findByText("Studio body");
      expect(provider()).toHaveAttribute("data-path", "share:beta");
      await act(async () => {
        old.resolve(
          refusal
            ? new Response("gone", {
                status: 404,
                headers: { "X-Sharecut-Error-Code": "share_not_found" },
              })
            : bootstrap("Alpha"),
        );
      });
      expect(provider()).toHaveAttribute("data-path", "share:beta");
      expect(provider()).toHaveAttribute("data-author", "Beta");
      expect(offline.clear).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["granted", true, "true"],
    ["refused", false, "false"],
    ["missing", "absent", "false"],
  ] as const)(
    "hands the bootstrap's transcript-words flag to the store provider when it is %s",
    async (_name, flag, want) => {
      serve(async () => bootstrap("Alpha", flag));
      render(<App />);
      await screen.findByText("Studio body");
      expect(provider()).toHaveAttribute("data-transcript-words", want);
    },
  );

  it("gives an offline cached review no transcript words", async () => {
    offline.load.mockResolvedValue({ project: cachedProject(), saved_at: 1 });
    serve(async () => {
      throw new TypeError("offline");
    });
    render(<App />);
    await screen.findByText("Studio body");
    expect(provider()).toHaveAttribute("data-transcript-words", "false");
  });

  it("retires the first A attempt across committed A B A routes", async () => {
    const firstA = deferred<Response>();
    const beta = deferred<Response>();
    const secondA = deferred<Response>();
    let alphaCalls = 0;
    const load = vi.fn((token: string) => {
      if (token === "alpha") {
        alphaCalls += 1;
        return alphaCalls === 1 ? firstA.promise : secondA.promise;
      }
      return beta.promise;
    });
    serve(load);
    const { rerender } = render(<App />);
    await waitFor(() => expect(alphaCalls).toBe(1));
    window.history.pushState({}, "", "/r/beta");
    rerender(<App />);
    await waitFor(() => expect(load).toHaveBeenCalledWith("beta"));
    window.history.pushState({}, "", "/r/alpha");
    rerender(<App />);
    await waitFor(() => expect(alphaCalls).toBe(2));
    await act(async () => {
      firstA.resolve(bootstrap("Retired Alpha"));
      beta.resolve(bootstrap("Retired Beta"));
    });
    expect(
      screen.queryByRole("region", { name: "Bootstrap provider" }),
    ).toBeNull();
    await act(async () => {
      secondA.resolve(bootstrap("Current Alpha"));
    });
    expect(provider()).toHaveAttribute("data-path", "share:alpha");
    expect(provider()).toHaveAttribute("data-author", "Current Alpha");
  });

  it("rejects a retired review's delayed offline-cache result", async () => {
    const oldCache = deferred<{ project: ProjectView; saved_at: number }>();
    offline.load.mockReturnValue(oldCache.promise);
    serve(async (token) => {
      if (token === "alpha") throw new TypeError("offline");
      return bootstrap("Beta");
    });
    const { rerender } = render(<App />);
    await waitFor(() => expect(offline.load).toHaveBeenCalledWith("alpha"));
    window.history.pushState({}, "", "/r/beta");
    rerender(<App />);
    await screen.findByText("Studio body");
    await act(async () => {
      oldCache.resolve({ project: cachedProject(), saved_at: 1 });
    });
    expect(provider()).toHaveAttribute("data-path", "share:beta");
    expect(provider()).toHaveAttribute("data-cached-name", "");
  });

  it("retains the same review's cached project when a later bootstrap succeeds", async () => {
    let calls = 0;
    offline.load.mockResolvedValue({ project: cachedProject(), saved_at: 1 });
    serve(async () => {
      if (++calls === 1) throw new TypeError("offline");
      return bootstrap("Alpha online");
    });
    const { rerender } = render(<App />);
    await screen.findByText("Studio body");
    expect(provider()).toHaveAttribute("data-cached-name", "Alpha cached");
    window.history.pushState({}, "", "/r/alpha?project=refresh");
    rerender(<App />);
    await waitFor(() =>
      expect(provider()).toHaveAttribute("data-author", "Alpha online"),
    );
    expect(provider()).toHaveAttribute("data-cached-name", "Alpha cached");
  });

  it("does not seed an online review with another token's cached project", async () => {
    offline.load.mockResolvedValue({ project: cachedProject(), saved_at: 1 });
    serve(async (token) => {
      if (token === "alpha") throw new TypeError("offline");
      return bootstrap("Beta");
    });
    const { rerender } = render(<App />);
    await screen.findByText("Studio body");
    expect(provider()).toHaveAttribute("data-cached-name", "Alpha cached");
    window.history.pushState({}, "", "/r/beta");
    rerender(<App />);
    await waitFor(() =>
      expect(provider()).toHaveAttribute("data-author", "Beta"),
    );
    expect(provider()).toHaveAttribute("data-path", "share:beta");
    expect(provider()).toHaveAttribute("data-cached-name", "");
  });

  it("lets the actual App wrapper retire the guest on a host-location change", async () => {
    serve(async () => bootstrap("Alpha"));
    const { rerender } = render(<App />);
    await screen.findByText("Studio body");
    expect(provider()).toHaveAttribute("data-path", "share:alpha");
    window.history.pushState({}, "", "/?project=/tmp/local.project.json");
    rerender(<App />);
    await waitFor(() =>
      expect(provider()).toHaveAttribute(
        "data-path",
        "/tmp/local.project.json",
      ),
    );
  });

  it("retires the offline retry timer while a new request is pending", async () => {
    const retry = deferred<Response>();
    let calls = 0;
    offline.load.mockResolvedValue(undefined);
    serve(async () => {
      if (++calls === 1) throw new TypeError("offline");
      return retry.promise;
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<App />);
    const button = await screen.findByRole("button", { name: "Try now" });
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(calls).toBe(2));
    expect(screen.getByRole("button", { name: "Trying…" })).toBe(button);
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveFocus();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(calls).toBe(2);
    await act(async () => {
      retry.resolve(bootstrap("Alpha"));
    });
    expect(provider()).toHaveAttribute("data-author", "Alpha");
  });

  it("keeps the cover and its button through a retry, and pauses the timer until it settles", async () => {
    const retry = deferred<Response>();
    let calls = 0;
    offline.load.mockResolvedValue(undefined);
    serve(async () => {
      if (++calls === 1) throw new TypeError("offline");
      if (calls === 2) return retry.promise;
      return bootstrap("Alpha");
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<App />);
    const button = await screen.findByRole("button", { name: "Try now" });
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(calls).toBe(2));
    expect(screen.getByRole("button", { name: "Trying…" })).toBe(button);
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveFocus();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(calls).toBe(2);
    await act(async () => {
      retry.resolve(new Response("{}", { status: 503, headers: {} }));
    });
    expect(
      screen.getByRole("heading", { name: "The host's computer is asleep" }),
    ).toBeInTheDocument();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_000);
    });
    expect(calls).toBe(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await waitFor(() => expect(calls).toBe(3));
    expect(await screen.findByText("Studio body")).toBeInTheDocument();
    expect(provider()).toHaveAttribute("data-author", "Alpha");
  });

  it("opens the episode at once when a retry succeeds, without holding the cover", async () => {
    let calls = 0;
    offline.load.mockResolvedValue(undefined);
    serve(async () => {
      if (++calls === 1) throw new TypeError("offline");
      return bootstrap("Alpha");
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Try now" }));
    expect(await screen.findByText("Studio body")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Try/ })).toBeNull();
  });

  it("drops the held failure when the link changes", async () => {
    const second = deferred<Response>();
    offline.load.mockResolvedValue(undefined);
    serve(async (token) => {
      if (token === "alpha") throw new TypeError("offline");
      return second.promise;
    });
    const { rerender } = render(<App />);
    await screen.findByRole("button", { name: "Try now" });
    window.history.pushState({}, "", "/r/beta");
    rerender(<App />);
    expect(screen.queryByRole("button", { name: /Try/ })).toBeNull();
    await act(async () => {
      second.resolve(bootstrap("Beta"));
    });
    expect(await screen.findByText("Studio body")).toBeInTheDocument();
  });
});
