import { act, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { resetFeaturesCache } from "./extensions/features";
import { useDawStore } from "./state/dawStore";
import {
  noteReviewAnswer,
  noteReviewTransportFailure,
} from "./state/hostReach";
import { requestSavedCopyReopen } from "./state/savedCopy";
import { minimalProject } from "./test/fixtures";
import { urlOf } from "./test/urlOf";

const studio = vi.hoisted(() => ({ mounts: 0 }));

vi.mock("./dawApp", () => ({
  DawApp: function StudioStub() {
    const caps = useDawStore((s) => s.shareCapabilities);
    useEffect(() => {
      studio.mounts += 1;
    }, []);
    return (
      <div>
        <span data-testid="caps">{caps ? caps.join(",") : "none"}</span>
        <input aria-label="Comment draft" />
      </div>
    );
  },
}));

const offline = vi.hoisted(() => ({ load: vi.fn(), clear: vi.fn() }));
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
  retireOfflineSnapshot: vi.fn(async () => undefined),
}));

type Answer = "host-down" | "live" | Response;
let answer: Answer = "host-down";
let projectCalls = 0;
let token = "";
let tokenSeq = 0;

function liveAnswer() {
  return new Response(
    JSON.stringify({
      capabilities: ["view", "comment"],
      guest_mode: "comment",
      reads_transcript_words: true,
      meta: { name: "Episode" },
    }),
    { status: 200 },
  );
}

beforeEach(() => {
  studio.mounts = 0;
  answer = "host-down";
  projectCalls = 0;
  offline.load.mockReset().mockResolvedValue({
    project: minimalProject({
      meta: { name: "Stale episode", workspace_dir: "/tmp/x" },
    }),
    saved_at: Date.now(),
  });
  offline.clear.mockReset().mockResolvedValue(undefined);
  audio.forget.mockReset().mockResolvedValue(undefined);
  resetFeaturesCache();
  token = `copy-${(tokenSeq += 1)}`;
  window.history.pushState({}, "", `/r/${token}`);
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
      if (!url.endsWith(`/api/review/${token}/project`)) {
        return new Response("{}", { status: 404 });
      }
      projectCalls += 1;
      if (answer === "host-down") throw new TypeError("Failed to fetch");
      return answer === "live" ? liveAnswer() : answer.clone();
    }),
  );
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.history.pushState({}, "", "/");
  resetFeaturesCache();
});

async function openCopy() {
  render(<App />);
  expect(await screen.findByTestId("caps")).toHaveTextContent("none");
  fireEvent.change(screen.getByLabelText("Comment draft"), {
    target: { value: "typed on the copy" },
  });
  return projectCalls;
}

async function pass(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function expectLiveStudioWithDraft(input: HTMLElement) {
  expect(screen.getByTestId("caps")).toHaveTextContent("view,comment");
  expect(screen.getByLabelText("Comment draft")).toBe(input);
  expect(input).toHaveValue("typed on the copy");
  expect(studio.mounts).toBe(1);
}

describe("a saved copy that leaves itself", () => {
  it("opens the live episode on the 30 second retry, in the same studio, keeping the draft", async () => {
    const before = await openCopy();
    const input = screen.getByLabelText("Comment draft");
    await pass(29_000);
    expect(projectCalls).toBe(before);
    answer = "live";
    await pass(2_000);
    expectLiveStudioWithDraft(input);
    expect(projectCalls).toBe(before + 1);
    await pass(60_000);
    expect(projectCalls).toBe(before + 1);
  });

  it("stays on the copy, with nothing in its way, when the retry fails", async () => {
    const before = await openCopy();
    const input = screen.getByLabelText("Comment draft");
    await pass(31_000);
    expect(projectCalls).toBe(before + 1);
    expect(screen.getByTestId("caps")).toHaveTextContent("none");
    expect(screen.getByLabelText("Comment draft")).toBe(input);
    expect(screen.queryByRole("alert")).toBeNull();
    await pass(30_000);
    expect(projectCalls).toBe(before + 2);
    expect(studio.mounts).toBe(1);
  });

  it("does not show a loading screen over the copy while a retry is in flight", async () => {
    const before = await openCopy();
    const input = screen.getByLabelText("Comment draft");
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchStub = vi.mocked(fetch);
    const inner = fetchStub.getMockImplementation();
    fetchStub.mockImplementation(async (input, init) => {
      if (urlOf(input as RequestInfo | URL).endsWith("/project")) await held;
      return inner ? inner(input, init) : new Response("{}");
    });
    await pass(31_000);
    expect(projectCalls).toBe(before);
    expect(screen.getByLabelText("Comment draft")).toBe(input);
    answer = "live";
    release();
    await pass(10);
    expectLiveStudioWithDraft(input);
  });

  it("tries again after a pending attempt when the host answered meanwhile", async () => {
    const before = await openCopy();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchStub = vi.mocked(fetch);
    const inner = fetchStub.getMockImplementation();
    fetchStub.mockImplementationOnce(async (input, init) => {
      await held;
      return inner ? inner(input, init) : new Response("{}");
    });
    await pass(31_000);
    act(() => {
      noteReviewTransportFailure(token);
      noteReviewTransportFailure(token);
    });
    act(() => noteReviewAnswer(token));
    await pass(10);
    expect(projectCalls).toBe(before);
    release();
    await pass(10);
    expect(projectCalls).toBe(before + 2);
  });

  it("tries again at once when the browser is back online", async () => {
    const before = await openCopy();
    const input = screen.getByLabelText("Comment draft");
    answer = "live";
    act(() => void window.dispatchEvent(new Event("online")));
    await pass(10);
    expect(projectCalls).toBe(before + 1);
    expectLiveStudioWithDraft(input);
  });

  it("tries again at once when the cover's Try now is pressed", async () => {
    const before = await openCopy();
    const input = screen.getByLabelText("Comment draft");
    answer = "live";
    act(() => requestSavedCopyReopen());
    await pass(10);
    expect(projectCalls).toBe(before + 1);
    expectLiveStudioWithDraft(input);
  });

  it("tries again when the host answers after being away", async () => {
    const before = await openCopy();
    act(() => {
      noteReviewTransportFailure(token);
      noteReviewTransportFailure(token);
    });
    answer = "live";
    act(() => noteReviewAnswer(token));
    await pass(10);
    expect(projectCalls).toBe(before + 1);
    expect(screen.getByTestId("caps")).toHaveTextContent("view,comment");
  });

  it("makes no attempt on an online event once the episode is live", async () => {
    await openCopy();
    answer = "live";
    await pass(31_000);
    const calls = projectCalls;
    act(() => void window.dispatchEvent(new Event("online")));
    act(() => requestSavedCopyReopen());
    await pass(10);
    expect(projectCalls).toBe(calls);
  });

  it("ends the session and deletes the copy when the link turns out to be gone", async () => {
    await openCopy();
    answer = new Response(JSON.stringify({ detail: "revoked" }), {
      status: 404,
      headers: { "X-Sharecut-Error-Code": "share_not_found" },
    });
    await pass(31_000);
    await pass(100);
    expect(
      await screen.findByText("This link doesn't open anything"),
    ).toBeInTheDocument();
    expect(offline.clear).toHaveBeenCalledWith(token);
    expect(audio.forget).toHaveBeenCalledWith(token);
    expect(screen.queryByLabelText("Comment draft")).toBeNull();
  });

  it("keeps the copy and the open page on a 403", async () => {
    await openCopy();
    answer = new Response("{}", {
      status: 403,
      headers: { "X-Sharecut-Error-Code": "share_token_mismatch" },
    });
    await pass(31_000);
    await pass(100);
    expect(offline.clear).not.toHaveBeenCalled();
    expect(audio.forget).not.toHaveBeenCalled();
    expect(
      screen.queryByText(/This link is only for certain people/),
    ).toBeNull();
  });
});
