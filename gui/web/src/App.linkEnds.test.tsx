import {
  act,
  configure,
  fireEvent,
  getConfig,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import App from "./App";
import { apiSend } from "./api/http";
import { resetFeaturesCache } from "./extensions/features";
import { composerPatch, initialSession } from "./state/composerSession";
import { useDawStore } from "./state/dawStore";
import { useUnsentText } from "./state/unsentText";
import { urlOf } from "./test/urlOf";

/**
 * Every wait here is for a state (the studio, the cover, the host's calls), so
 * it may last as long as the test itself (Vitest's default of 5 s) instead of
 * the one second Testing Library gives `waitFor` and `findBy*`, which a busy
 * machine can overrun.
 */
const STATE_WAIT_MS = 5_000;
const defaultWaitMs = getConfig().asyncUtilTimeout;
beforeAll(() => configure({ asyncUtilTimeout: STATE_WAIT_MS }));
afterAll(() => configure({ asyncUtilTimeout: defaultWaitMs }));

/** A studio stand-in: a reply field that registers its draft, and a button that makes the page's own kind of request. */
function FakeStudio() {
  const [reply, setReply] = useState("");
  useUnsentText("Your reply", reply);
  const token = window.location.pathname.split("/").pop() ?? "";
  return (
    <div>
      <p>Guest studio</p>
      <textarea
        aria-label="Reply"
        value={reply}
        onChange={(e) => setReply(e.target.value)}
      />
      <button
        type="button"
        onClick={() =>
          void apiSend(`share:${token}`, { guest: "/daw/meta" }).catch(
            () => undefined,
          )
        }
      >
        Ask
      </button>
    </div>
  );
}
vi.mock("./dawApp", () => ({ DawApp: FakeStudio }));

/** Lets a test turn the share routes off and on again between renders. */
const routes = vi.hoisted(() => ({ on: true }));
vi.mock("./extensions/FeaturesContext", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./extensions/FeaturesContext")>();
  return {
    ...original,
    useHasFeature: (id: string) => routes.on && original.useHasFeature(id),
  };
});

const offline = vi.hoisted(() => ({
  load: vi.fn(),
  clear: vi.fn(),
  retire: vi.fn(),
}));
vi.mock("./services/offlineQueue/offlineStore", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("./services/offlineQueue/offlineStore")
  >()),
  loadOfflineSnapshot: offline.load,
  clearOfflineSnapshot: offline.clear,
  retireOfflineSnapshot: offline.retire,
}));

const FEATURES = JSON.stringify({
  api_version: 1,
  features: ["share.ui.routes", "share.ui.banner", "share.ui.menu"],
});
const OPEN = () =>
  new Response(
    JSON.stringify({
      capabilities: ["view", "comment"],
      guest_mode: "comment",
      reads_transcript_words: false,
      meta: { name: "Episode" },
    }),
  );
const DEAD = () =>
  new Response(JSON.stringify({ detail: "invalid or revoked share token" }), {
    status: 404,
    headers: { "X-Sharecut-Error-Code": "share_not_found" },
  });

type Answers = {
  project: Array<() => Response>;
  meta: () => Response;
};

/** The project answers come from a list, last one repeating; `meta` is the page's own poll. */
function stubHost({ project, meta }: Answers) {
  let projectCalls = 0;
  const spy = vi.fn(async (input: RequestInfo | URL) => {
    const url = urlOf(input);
    if (url.includes("/features")) return new Response(FEATURES);
    if (url.endsWith("/project")) {
      const answer = project[Math.min(projectCalls, project.length - 1)]!;
      projectCalls += 1;
      return answer();
    }
    if (url.endsWith("/daw/meta")) return meta();
    return new Response("{}", { status: 404 });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

async function openEpisode(token: string) {
  window.history.pushState({}, "", `/r/${token}`);
  render(<App />);
  await screen.findByText("Guest studio");
}

beforeEach(() => {
  routes.on = true;
  offline.load.mockReset().mockResolvedValue(undefined);
  offline.clear.mockReset().mockResolvedValue(undefined);
  offline.retire.mockReset().mockResolvedValue(undefined);
  useDawStore.setState(composerPatch(initialSession));
  resetFeaturesCache();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/");
  resetFeaturesCache();
});

describe("a review link turned off while the episode is open", () => {
  it("replaces the studio with the cover after one confirming check and hands back what was typed", async () => {
    const spy = stubHost({ project: [OPEN, DEAD], meta: DEAD });
    await openEpisode("ends-1");
    fireEvent.change(screen.getByRole("textbox", { name: "Reply" }), {
      target: { value: "  a reply I had not sent " },
    });
    useDawStore.setState({
      isPlaying: true,
      ...composerPatch({
        ...initialSession,
        draft: {
          text: "my comment",
          anchor: { time: 1 } as never,
          resume: false,
          typed: true,
        },
      }),
    });

    fireEvent.click(screen.getByRole("button", { name: "Ask" }));

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "This link doesn't open anything",
      }),
    ).toHaveFocus();
    expect(
      screen.getByText("Ask the person who sent it for a new link."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Guest studio")).toBeNull();
    expect(
      screen.getByRole("textbox", { name: "These were not posted" }),
    ).toHaveValue(
      "Your comment:\nmy comment\n\nYour reply:\n  a reply I had not sent ",
    );
    expect(document.body.textContent).not.toContain("invalid or revoked");
    expect(useDawStore.getState().isPlaying).toBe(false);
    expect(useDawStore.getState().composer).toEqual(initialSession);
    expect(offline.retire).toHaveBeenCalledExactlyOnceWith("ends-1");

    const seen = spy.mock.calls.length;
    await act(async () => {
      await apiSend("share:ends-1", { guest: "/daw/meta" }).catch(
        () => undefined,
      );
    });
    expect(spy.mock.calls.length).toBe(seen);
  });

  it("has no block and no button when nothing was typed", async () => {
    stubHost({ project: [OPEN, DEAD], meta: DEAD });
    await openEpisode("ends-2");
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    await screen.findByRole("heading", {
      name: "This link doesn't open anything",
    });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps the studio and the typed text when the confirming check finds the link alive", async () => {
    const spy = stubHost({ project: [OPEN], meta: DEAD });
    await openEpisode("ends-3");
    fireEvent.change(screen.getByRole("textbox", { name: "Reply" }), {
      target: { value: "still here" },
    });
    const before = spy.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() =>
      expect(spy.mock.calls.length).toBeGreaterThan(before + 1),
    );
    await act(async () => {});
    expect(screen.getByText("Guest studio")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Reply" })).toHaveValue(
      "still here",
    );
    expect(offline.retire).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a busy host",
      () =>
        new Response("{}", {
          status: 503,
          headers: { "X-Sharecut-Error-Code": "project_busy" },
        }),
    ],
    ["a rate limit", () => new Response("", { status: 429 })],
    ["a server error", () => new Response("boom", { status: 500 })],
    ["an uncoded 404", () => new Response("{}", { status: 404 })],
  ])(
    "keeps the studio when the confirming check meets %s",
    async (_name, answer) => {
      const spy = stubHost({ project: [OPEN, answer], meta: DEAD });
      await openEpisode(`ends-4-${_name.replaceAll(" ", "-")}`);
      const before = spy.mock.calls.length;
      fireEvent.click(screen.getByRole("button", { name: "Ask" }));
      await waitFor(() =>
        expect(spy.mock.calls.length).toBeGreaterThan(before + 1),
      );
      await act(async () => {});
      expect(screen.getByText("Guest studio")).toBeInTheDocument();
      expect(offline.retire).not.toHaveBeenCalled();
    },
  );

  it("keeps the studio when the confirming check cannot reach the host", async () => {
    const spy = vi.fn(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      if (url.includes("/features")) return new Response(FEATURES);
      if (url.endsWith("/daw/meta")) return DEAD();
      if (
        spy.mock.calls.filter((c) =>
          urlOf(c[0] as RequestInfo).endsWith("/project"),
        ).length > 1
      )
        throw new TypeError("Failed to fetch");
      return OPEN();
    });
    vi.stubGlobal("fetch", spy);
    await openEpisode("ends-5");
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    await act(async () => {});
    await act(async () => {});
    expect(screen.getByText("Guest studio")).toBeInTheDocument();
  });

  describe("after the end", () => {
    // An ended link stays ended for the page, so each test needs its own.
    let tokenCount = 0;
    function held() {
      let resolve: (answer: Response) => void = () => {};
      const promise = new Promise<Response>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    }

    /**
     * The first attempt fails (Try now), the second and third hang. One of
     * them opens the episode, the other is still on its way when the link is
     * turned off. Every later project answer is the dead-link answer.
     */
    async function endedWithOneAttemptHeld(opens: "second" | "third") {
      const second = held();
      const third = held();
      let projectCalls = 0;
      const spy = vi.fn(async (input: RequestInfo | URL) => {
        const url = urlOf(input);
        if (url.includes("/features")) return new Response(FEATURES);
        if (url.endsWith("/daw/meta")) return DEAD();
        if (!url.endsWith("/project"))
          return new Response("{}", { status: 404 });
        projectCalls += 1;
        if (projectCalls === 1) throw new TypeError("offline");
        if (projectCalls === 2) return second.promise;
        if (projectCalls === 3) return third.promise;
        return DEAD();
      });
      vi.stubGlobal("fetch", spy);
      vi.useFakeTimers({ shouldAdvanceTime: true });
      window.history.pushState(
        {},
        "",
        `/r/after-end-${opens}-${(tokenCount += 1)}`,
      );
      const view = render(<App />);
      fireEvent.click(await screen.findByRole("button", { name: "Try now" }));
      await waitFor(() => expect(projectCalls).toBe(2));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(31_000);
      });
      await waitFor(() => expect(projectCalls).toBe(3));
      const [opening, late] =
        opens === "second" ? [second, third] : [third, second];
      await act(async () => {
        opening.resolve(OPEN());
      });
      await screen.findByText("Guest studio");
      fireEvent.change(screen.getByRole("textbox", { name: "Reply" }), {
        target: { value: "typed before the end" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Ask" }));
      await screen.findByRole("heading", {
        name: "This link doesn't open anything",
      });
      return { spy, late, view, projectCalls: () => projectCalls };
    }

    const projectRequests = (spy: ReturnType<typeof vi.fn>) =>
      spy.mock.calls.filter((call) =>
        urlOf(call[0] as RequestInfo).endsWith("/project"),
      ).length;

    it.each(["second", "third"] as const)(
      "keeps the cover when the attempt held back (%s opened it) answers with the episode, and never shows the loading screen",
      async (opens) => {
        const { late } = await endedWithOneAttemptHeld(opens);
        let loadingSeen = false;
        const watcher = new MutationObserver(() => {
          if (document.body.textContent?.includes("Loading the episode"))
            loadingSeen = true;
        });
        watcher.observe(document.body, {
          subtree: true,
          childList: true,
          characterData: true,
        });
        await act(async () => {
          late.resolve(OPEN());
        });
        await act(async () => {});
        watcher.disconnect();
        expect(loadingSeen).toBe(false);
        expect(screen.queryByText("Guest studio")).toBeNull();
        expect(
          screen.getByRole("heading", {
            level: 1,
            name: "This link doesn't open anything",
          }),
        ).toBeInTheDocument();
        expect(
          screen.getByRole("textbox", { name: "Your reply was not posted" }),
        ).toHaveValue("typed before the end");
      },
    );

    it("leaves the cover as it is when the share routes go away and come back, and asks the host nothing more", async () => {
      const { spy, view } = await endedWithOneAttemptHeld("second");
      const asked = projectRequests(spy);
      const savedCopiesRead = offline.load.mock.calls.length;
      const unsent = () =>
        screen.getByRole("textbox", { name: "Your reply was not posted" });
      routes.on = false;
      await act(async () => {
        view.rerender(<App />);
      });
      expect(
        screen.getByRole("heading", {
          level: 1,
          name: "This link doesn't open anything",
        }),
      ).toBeInTheDocument();
      expect(unsent()).toHaveValue("typed before the end");
      expect(screen.queryByText(/not available/i)).toBeNull();
      routes.on = true;
      await act(async () => {
        view.rerender(<App />);
      });
      await act(async () => {});
      expect(screen.queryByText("Guest studio")).toBeNull();
      expect(
        screen.getByRole("heading", {
          level: 1,
          name: "This link doesn't open anything",
        }),
      ).toBeInTheDocument();
      expect(unsent()).toHaveValue("typed before the end");
      expect(projectRequests(spy)).toBe(asked);
      // No new attempt even starts: it would end by looking for a saved copy.
      expect(offline.load.mock.calls.length).toBe(savedCopiesRead);
    });
  });
});
