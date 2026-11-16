import {
  act,
  cleanup,
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

/** The signal each bootstrap request was sent with, oldest first. */
function projectSignals(fetchMock: ReturnType<typeof serve>) {
  return fetchMock.mock.calls
    .filter(([input]) => urlOf(input).endsWith("/project"))
    .map(([, init]) => init?.signal as AbortSignal);
}

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

function serve(
  load: (token: string) => Promise<Response>,
  { ignoreAbort = false }: { ignoreAbort?: boolean } = {},
) {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.includes("/features")) {
        return new Response(
          JSON.stringify({ api_version: 1, features: ["share.ui.routes"] }),
          { status: 200 },
        );
      }
      const token = url.match(/\/api\/review\/([^/]+)\/project$/)?.[1];
      if (!token) return new Response("not found", { status: 404 });
      // Like a real fetch, an aborted request rejects with an AbortError.
      return new Promise<Response>((answer, fail) => {
        if (!ignoreAbort) {
          init?.signal?.addEventListener("abort", () =>
            fail(new DOMException("Aborted", "AbortError")),
          );
        }
        load(token).then(answer, fail);
      });
    },
  );
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

  it("replaces a retry that never answers after 30 seconds, and ignores the replaced one's late answer", async () => {
    const hung = deferred<Response>();
    let calls = 0;
    offline.load.mockResolvedValue(undefined);
    serve(async () => {
      if (++calls === 1) throw new TypeError("offline");
      if (calls === 2) return hung.promise;
      return bootstrap("Beta");
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
      await vi.advanceTimersByTimeAsync(29_000);
    });
    expect(calls).toBe(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await waitFor(() => expect(calls).toBe(3));
    expect(await screen.findByText("Studio body")).toBeInTheDocument();
    expect(provider()).toHaveAttribute("data-author", "Beta");
    await act(async () => {
      hung.resolve(new Response("{}", { status: 500 }));
    });
    expect(provider()).toHaveAttribute("data-author", "Beta");
    expect(
      screen.queryByRole("heading", { name: "This link did not load" }),
    ).toBeNull();
  });

  it("counts the 30 seconds from the start of each attempt, so a press restarts them", async () => {
    let calls = 0;
    offline.load.mockResolvedValue(undefined);
    serve(async () => {
      if (++calls <= 2) throw new TypeError("offline");
      return bootstrap("Alpha");
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<App />);
    const button = await screen.findByRole("button", { name: "Try now" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    fireEvent.click(button);
    await waitFor(() => expect(calls).toBe(2));
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

  it("opens the episode at once when a retry succeeds, without holding the cover for the 600 ms floor", async () => {
    let calls = 0;
    offline.load.mockResolvedValue(undefined);
    serve(async () => {
      if (++calls === 1) throw new TypeError("offline");
      return bootstrap("Alpha");
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Try now" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(screen.getByText("Studio body")).toBeInTheDocument();
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

  describe("a replaced attempt for the same link", () => {
    /** Attempt 1 fails (asleep), attempt 2 (pressed) and attempt 3 (the 30 s replacement) both hang. */
    async function replacedWhileHung() {
      const second = deferred<Response>();
      const third = deferred<Response>();
      let calls = 0;
      offline.load.mockResolvedValue(undefined);
      const fetchMock = serve(async () => {
        if (++calls === 1) throw new TypeError("offline");
        return calls === 2 ? second.promise : third.promise;
      });
      vi.useFakeTimers({ shouldAdvanceTime: true });
      render(<App />);
      fireEvent.click(await screen.findByRole("button", { name: "Try now" }));
      await waitFor(() => expect(calls).toBe(2));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000);
      });
      await waitFor(() => expect(calls).toBe(3));
      return { second, third, fetchMock };
    }

    it("aborts the oldest attempt in flight when a fourth starts, never the newest three", async () => {
      let calls = 0;
      offline.load.mockResolvedValue(undefined);
      const fetchMock = serve(async () => {
        if (++calls === 1) throw new TypeError("offline");
        return new Promise<Response>(() => {});
      });
      vi.useFakeTimers({ shouldAdvanceTime: true });
      render(<App />);
      await screen.findByRole("button", { name: "Try now" });
      for (let tick = 0; tick < 125; tick += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_000);
        });
      }
      await waitFor(() => expect(calls).toBe(5));
      const [, first, second, third, fourth] = projectSignals(fetchMock).map(
        (signal) => signal.aborted,
      );
      expect([first, second, third, fourth]).toEqual([
        true,
        false,
        false,
        false,
      ]);
      expect(
        screen.getByRole("heading", { name: "The host's computer is asleep" }),
      ).toBeInTheDocument();
    });

    it("aborts the other attempts when a replaced one opens the episode", async () => {
      const { second, fetchMock } = await replacedWhileHung();
      await act(async () => {
        second.resolve(bootstrap("Alpha"));
      });
      await screen.findByText("Studio body");
      const signals = projectSignals(fetchMock);
      expect(signals[2]?.aborted).toBe(true);
      expect(screen.getByText("Studio body")).toBeInTheDocument();
    });

    it("aborts the attempt in flight for the old link when the link changes", async () => {
      const fetchMock = serve((token) =>
        token === "alpha"
          ? new Promise<Response>(() => {})
          : new Promise<Response>(() => {}),
      );
      const { rerender } = render(<App />);
      await waitFor(() => expect(projectSignals(fetchMock)).toHaveLength(1));
      const [forAlpha] = projectSignals(fetchMock);
      expect(forAlpha?.aborted).toBe(false);
      window.history.pushState({}, "", "/r/beta");
      rerender(<App />);
      // Beta never answers, so only the link change can have aborted alpha's.
      await waitFor(() => expect(projectSignals(fetchMock)).toHaveLength(2));
      expect(forAlpha?.aborted).toBe(true);
      expect(projectSignals(fetchMock)[1]?.aborted).toBe(false);
    });

    it("reads no saved copy and shows nothing for the newest attempt that an older one's episode aborted", async () => {
      const { second, third, fetchMock } = await replacedWhileHung();
      offline.load.mockResolvedValue({ project: cachedProject(), saved_at: 1 });
      const reads = offline.load.mock.calls.length;
      await act(async () => {
        second.resolve(bootstrap("Alpha"));
      });
      await screen.findByText("Studio body");
      // The abort already rejected the newest attempt like a real fetch does.
      expect(projectSignals(fetchMock)[2]?.aborted).toBe(true);
      await act(async () => {
        third.resolve(bootstrap("Never"));
      });
      expect(offline.load).toHaveBeenCalledTimes(reads);
      expect(provider()).toHaveAttribute("data-author", "Alpha");
      expect(screen.queryByText(/saved copy/i)).toBeNull();
    });

    it("aborts the older attempts when the newest one opens the saved copy", async () => {
      const { third, fetchMock } = await replacedWhileHung();
      offline.load.mockResolvedValue({ project: cachedProject(), saved_at: 1 });
      await act(async () => {
        third.resolve(new Response("{}", { status: 500 }));
      });
      expect(await screen.findByText("Studio body")).toBeInTheDocument();
      expect(projectSignals(fetchMock)[1]?.aborted).toBe(true);
    });

    it("ignores an attempt for a link the page left and came back to, even if its request was never cancelled", async () => {
      const old = deferred<Response>();
      let calls = 0;
      const fetchMock = serve(
        (token) => {
          calls += 1;
          return calls === 1 && token === "alpha"
            ? old.promise
            : new Promise<Response>(() => {});
        },
        { ignoreAbort: true },
      );
      const { rerender } = render(<App />);
      await waitFor(() => expect(calls).toBe(1));
      window.history.pushState({}, "", "/r/beta");
      rerender(<App />);
      await waitFor(() => expect(calls).toBe(2));
      window.history.pushState({}, "", "/r/alpha");
      rerender(<App />);
      await waitFor(() => expect(calls).toBe(3));
      await act(async () => {
        old.resolve(bootstrap("Alpha"));
      });
      expect(screen.queryByText("Studio body")).toBeNull();
      expect(projectSignals(fetchMock)).toHaveLength(3);
    });

    it("aborts every attempt in flight when the page leaves", async () => {
      const { fetchMock } = await replacedWhileHung();
      cleanup();
      const signals = projectSignals(fetchMock);
      expect(signals[1]?.aborted).toBe(true);
      expect(signals[2]?.aborted).toBe(true);
    });

    it("still opens when the attempt before last answers under a 5 s delay", async () => {
      let calls = 0;
      offline.load.mockResolvedValue(undefined);
      serve(async () => {
        if (++calls === 1) {
          return new Response("{}", {
            status: 429,
            headers: { "Retry-After": "5" },
          });
        }
        await new Promise((done) => setTimeout(done, 14_000));
        return bootstrap("Alpha");
      });
      vi.useFakeTimers({ shouldAdvanceTime: true });
      render(<App />);
      await screen.findByRole("heading", { name: "This link did not load" });
      for (let second = 0; second < 22; second += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_000);
        });
      }
      expect(await screen.findByText("Studio body")).toBeInTheDocument();
    });

    it("opens the episode when it answers late with the episode", async () => {
      const { second } = await replacedWhileHung();
      await act(async () => {
        second.resolve(bootstrap("Alpha"));
      });
      expect(await screen.findByText("Studio body")).toBeInTheDocument();
      expect(provider()).toHaveAttribute("data-author", "Alpha");
      expect(screen.queryByRole("button", { name: /Try/ })).toBeNull();
    });

    it("changes nothing when it fails late", async () => {
      const { second } = await replacedWhileHung();
      await act(async () => {
        second.resolve(new Response("{}", { status: 500 }));
      });
      expect(
        screen.getByRole("heading", { name: "The host's computer is asleep" }),
      ).toBeInTheDocument();
      expect(screen.queryByText("Studio body")).toBeNull();
      expect(offline.load).toHaveBeenCalledTimes(1);
    });

    it("leaves the open episode open when the newest attempt then fails", async () => {
      const { second, third } = await replacedWhileHung();
      await act(async () => {
        second.resolve(bootstrap("Alpha"));
      });
      await screen.findByText("Studio body");
      await act(async () => {
        third.resolve(new Response("{}", { status: 500 }));
      });
      expect(screen.getByText("Studio body")).toBeInTheDocument();
      expect(provider()).toHaveAttribute("data-author", "Alpha");
      expect(
        screen.queryByRole("heading", {
          name: "The host's computer is asleep",
        }),
      ).toBeNull();
    });

    it("abandons the newest attempt when a replaced one opens the episode, so what opened stays", async () => {
      const { second, third, fetchMock } = await replacedWhileHung();
      await act(async () => {
        second.resolve(bootstrap("Alpha"));
      });
      await screen.findByText("Studio body");
      expect(projectSignals(fetchMock)[2]?.aborted).toBe(true);
      await act(async () => {
        third.resolve(bootstrap("Fresher"));
      });
      expect(provider()).toHaveAttribute("data-author", "Alpha");
    });

    it("is ignored when it answers after the link changed", async () => {
      const { second } = await replacedWhileHung();
      const beta = deferred<Response>();
      serve(async (token) =>
        token === "beta" ? beta.promise : bootstrap("Alpha"),
      );
      window.history.pushState({}, "", "/r/beta");
      cleanup();
      render(<App />);
      await act(async () => {
        second.resolve(bootstrap("Alpha"));
      });
      expect(screen.queryByText("Studio body")).toBeNull();
      await act(async () => {
        beta.resolve(bootstrap("Beta"));
      });
      expect(await screen.findByText("Studio body")).toBeInTheDocument();
      expect(provider()).toHaveAttribute("data-path", "share:beta");
    });

    /**
     * Attempt 1 is rate-limited (retry in 5 s), attempt 2 hangs, attempt 3
     * (replacing it) gets `third` at once and settles. The slow attempt 2 is
     * still in flight while nothing is pending.
     */
    async function replacedAfterNewerSettled(third: () => Response) {
      const second = deferred<Response>();
      let calls = 0;
      offline.load.mockResolvedValue(undefined);
      serve(async () => {
        calls += 1;
        if (calls === 1) {
          return new Response("{}", {
            status: 429,
            headers: { "Retry-After": "5" },
          });
        }
        return calls === 2 ? second.promise : third();
      });
      vi.useFakeTimers({ shouldAdvanceTime: true });
      render(<App />);
      await screen.findByRole("heading", { name: "This link did not load" });
      for (let tick = 0; tick < 11; tick += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_000);
        });
      }
      await waitFor(() => expect(calls).toBe(3));
      return { second, calls: () => calls };
    }

    it("opens the episode when it answers after a newer attempt failed with a 429, and stops retrying", async () => {
      const { second, calls } = await replacedAfterNewerSettled(
        () =>
          new Response("{}", {
            status: 429,
            headers: { "Retry-After": "30" },
          }),
      );
      await act(async () => {
        second.resolve(bootstrap("Alpha"));
      });
      expect(await screen.findByText("Studio body")).toBeInTheDocument();
      expect(provider()).toHaveAttribute("data-author", "Alpha");
      const seen = calls();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(120_000);
      });
      expect(calls()).toBe(seen);
      expect(screen.getByText("Studio body")).toBeInTheDocument();
    });

    it("keeps the dead-link cover when it answers after a newer attempt got share_not_found", async () => {
      const { second } = await replacedAfterNewerSettled(
        () =>
          new Response("gone", {
            status: 404,
            headers: { "X-Sharecut-Error-Code": "share_not_found" },
          }),
      );
      await act(async () => {
        second.resolve(bootstrap("Alpha"));
      });
      expect(
        screen.getByRole("heading", {
          name: "This link doesn't open anything",
        }),
      ).toBeInTheDocument();
      expect(screen.queryByText("Studio body")).toBeNull();
    });

    it("lets a host that takes 12 s open the episode under a 5 s rate-limit delay", async () => {
      let calls = 0;
      offline.load.mockResolvedValue(undefined);
      serve(async () => {
        if (++calls === 1) {
          return new Response("{}", {
            status: 429,
            headers: { "Retry-After": "5" },
          });
        }
        await new Promise((done) => setTimeout(done, 12_000));
        return bootstrap("Alpha");
      });
      vi.useFakeTimers({ shouldAdvanceTime: true });
      render(<App />);
      await screen.findByRole("heading", { name: "This link did not load" });
      // One act per second: React applies the retry's state change when an act
      // ends, and each attempt must start before the next delay is counted.
      for (let second = 0; second < 20; second += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1_000);
        });
      }
      expect(calls).toBeGreaterThan(2);
      expect(screen.getByText("Studio body")).toBeInTheDocument();
    });
  });

  it("returns a pressed Retry to idle 30 s after it started when nothing answers, and takes a new press", async () => {
    const first = deferred<Response>();
    let calls = 0;
    offline.load.mockResolvedValue(undefined);
    serve(async () => {
      if (++calls === 1) return new Response("{}", { status: 500 });
      if (calls === 2) return first.promise;
      return new Promise<Response>(() => {});
    });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<App />);
    const button = await screen.findByRole("button", { name: "Retry" });
    fireEvent.click(button);
    await waitFor(() => expect(calls).toBe(2));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_900);
    });
    expect(screen.getByRole("button", { name: "Trying…" })).toBe(button);
    expect(button).toHaveAttribute("aria-busy", "true");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(screen.getByRole("button", { name: "Retry" })).toBe(button);
    expect(button).not.toHaveAttribute("aria-busy");
    expect(screen.getByRole("status")).toHaveTextContent("Still not loading.");
    fireEvent.click(button);
    await waitFor(() => expect(calls).toBe(3));
    expect(screen.getByRole("button", { name: "Trying…" })).toBe(button);
    await act(async () => {
      first.resolve(bootstrap("Alpha"));
    });
    expect(await screen.findByText("Studio body")).toBeInTheDocument();
    expect(provider()).toHaveAttribute("data-author", "Alpha");
  });
});
