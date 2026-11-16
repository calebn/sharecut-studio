import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reportLinkDoubt } from "../api/linkState";
import {
  CONFIRM_TIMEOUT_MS,
  confirmDeadLink,
  QUIET_AFTER_ALIVE_MS,
  useDeadLinkWatch,
} from "./useDeadLinkWatch";

const ALIVE = () =>
  new Response(
    JSON.stringify({
      capabilities: ["view"],
      reads_transcript_words: false,
      meta: {},
    }),
  );
const DEAD = () =>
  new Response(JSON.stringify({ detail: "invalid or revoked share token" }), {
    status: 404,
    headers: { "X-Sharecut-Error-Code": "share_not_found" },
  });

type Answer = () => Response | Promise<Response>;

function stubFetch(answer: Answer) {
  const spy = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const signal = init?.signal;
    if (signal?.aborted) throw signal.reason;
    return answer();
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}

/** A request that never answers on its own and fails when it is aborted. */
function hung() {
  return vi.fn(
    (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(init.signal?.reason),
        );
      }),
  );
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("confirmDeadLink", () => {
  it("is true only when the link answers with the dead-link answer", async () => {
    stubFetch(DEAD);
    await expect(confirmDeadLink("t")).resolves.toBe(true);
  });

  it.each([
    ["a live link", ALIVE],
    ["an uncoded 404", () => new Response("{}", { status: 404 })],
    [
      "a 404 with another code",
      () =>
        new Response("{}", {
          status: 404,
          headers: { "X-Sharecut-Error-Code": "comment_not_found" },
        }),
    ],
    [
      "a 403",
      () =>
        new Response("{}", {
          status: 403,
          headers: { "X-Sharecut-Error-Code": "share_not_found" },
        }),
    ],
    ["a 500", () => new Response("boom", { status: 500 })],
    ["a 502", () => new Response("", { status: 502 })],
    [
      "a busy host",
      () =>
        new Response("{}", {
          status: 503,
          headers: { "X-Sharecut-Error-Code": "project_busy" },
        }),
    ],
    ["a rate limit", () => new Response("", { status: 429 })],
  ])("is false for %s", async (_name, answer) => {
    stubFetch(answer);
    await expect(confirmDeadLink("t")).resolves.toBe(false);
  });

  it("is false for a lost connection and never rejects", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(confirmDeadLink("t")).resolves.toBe(false);
  });

  it("is false when the host does not answer within the limit", async () => {
    vi.stubGlobal("fetch", hung());
    const result = confirmDeadLink("t");
    await vi.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS);
    await expect(result).resolves.toBe(false);
  });

  it("is false when the caller aborts", async () => {
    vi.stubGlobal("fetch", hung());
    const controller = new AbortController();
    const result = confirmDeadLink("t", controller.signal);
    controller.abort();
    await expect(result).resolves.toBe(false);
  });
});

describe("useDeadLinkWatch", () => {
  const flush = () => act(async () => vi.advanceTimersByTimeAsync(0));

  it("ends the session only when the confirming check finds the dead-link answer", async () => {
    const spy = stubFetch(DEAD);
    const ended = vi.fn();
    renderHook(() => useDeadLinkWatch("w1", ended));
    act(() => reportLinkDoubt("w1"));
    await flush();
    expect(ended).toHaveBeenCalledExactlyOnceWith("w1");
    expect(spy).toHaveBeenCalledOnce();
    expect(String(spy.mock.calls[0]?.[0])).toBe("/api/review/w1/project");
  });

  it("ends nothing on a doubt the check does not confirm, and keeps nothing", async () => {
    stubFetch(ALIVE);
    const ended = vi.fn();
    renderHook(() => useDeadLinkWatch("w2", ended));
    act(() => reportLinkDoubt("w2"));
    await flush();
    expect(ended).not.toHaveBeenCalled();
  });

  it.each([
    ["a busy host", () => new Response("{}", { status: 503 })],
    ["a rate limit", () => new Response("", { status: 429 })],
    ["a 500", () => new Response("boom", { status: 500 })],
    ["an uncoded 404", () => new Response("{}", { status: 404 })],
  ])("ends nothing when the check meets %s", async (_name, answer) => {
    stubFetch(answer);
    const ended = vi.fn();
    renderHook(() => useDeadLinkWatch("w3", ended));
    act(() => reportLinkDoubt("w3"));
    await flush();
    expect(ended).not.toHaveBeenCalled();
  });

  it("ends nothing when the check times out", async () => {
    vi.stubGlobal("fetch", hung());
    const ended = vi.fn();
    renderHook(() => useDeadLinkWatch("w4", ended));
    act(() => reportLinkDoubt("w4"));
    await act(async () => vi.advanceTimersByTimeAsync(CONFIRM_TIMEOUT_MS + 10));
    expect(ended).not.toHaveBeenCalled();
  });

  it("asks once for two doubts that arrive while the check is out", async () => {
    let release: (res: Response) => void = () => {};
    const spy = stubFetch(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const ended = vi.fn();
    renderHook(() => useDeadLinkWatch("w5", ended));
    act(() => {
      reportLinkDoubt("w5");
      reportLinkDoubt("w5");
    });
    await flush();
    expect(spy).toHaveBeenCalledOnce();
    await act(async () => release(DEAD()));
    expect(ended).toHaveBeenCalledOnce();
  });

  it("stays quiet for a few seconds after a check found the link alive", async () => {
    const spy = stubFetch(ALIVE);
    renderHook(() => useDeadLinkWatch("w6", vi.fn()));
    act(() => reportLinkDoubt("w6"));
    await flush();
    act(() => reportLinkDoubt("w6"));
    await flush();
    expect(spy).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(QUIET_AFTER_ALIVE_MS));
    act(() => reportLinkDoubt("w6"));
    await flush();
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("ignores a doubt about another link", async () => {
    const spy = stubFetch(DEAD);
    const ended = vi.fn();
    renderHook(() => useDeadLinkWatch("w7", ended));
    act(() => reportLinkDoubt("somebody-else"));
    await flush();
    expect(spy).not.toHaveBeenCalled();
    expect(ended).not.toHaveBeenCalled();
  });

  it("listens to nothing while no episode is open", async () => {
    const spy = stubFetch(DEAD);
    const ended = vi.fn();
    renderHook(() => useDeadLinkWatch(null, ended));
    act(() => reportLinkDoubt("w8"));
    await flush();
    expect(spy).not.toHaveBeenCalled();
    expect(ended).not.toHaveBeenCalled();
  });

  it("drops a result that arrives after the link changed", async () => {
    let release: (res: Response) => void = () => {};
    stubFetch(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const ended = vi.fn();
    const { rerender } = renderHook(
      ({ token }) => useDeadLinkWatch(token, ended),
      { initialProps: { token: "w9" } },
    );
    act(() => reportLinkDoubt("w9"));
    await flush();
    rerender({ token: "w9-other" });
    await act(async () => release(DEAD()));
    expect(ended).not.toHaveBeenCalled();
  });

  it("calls nothing when the page goes away during the check", async () => {
    let release: (res: Response) => void = () => {};
    stubFetch(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const ended = vi.fn();
    const { unmount } = renderHook(() => useDeadLinkWatch("w10", ended));
    act(() => reportLinkDoubt("w10"));
    await flush();
    unmount();
    await act(async () => release(DEAD()));
    expect(ended).not.toHaveBeenCalled();
  });

  it("stops listening when it unmounts", async () => {
    const spy = stubFetch(DEAD);
    const { unmount } = renderHook(() => useDeadLinkWatch("w11", vi.fn()));
    unmount();
    act(() => reportLinkDoubt("w11"));
    await flush();
    expect(spy).not.toHaveBeenCalled();
  });
});
