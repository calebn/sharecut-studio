import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hostReachEpoch,
  noteReviewAnswer,
  noteReviewTransportFailure,
  resetHostReach,
  setHostReachProbe,
  subscribeHostBack,
  useHostBackCount,
  useHostCause,
  watchHostReach,
} from "./hostReach";

let online = true;

beforeEach(() => {
  online = true;
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
  vi.useFakeTimers();
  resetHostReach();
});

afterEach(() => {
  setHostReachProbe(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const cause = (token = "t1") =>
  renderHook(() => useHostCause(token)).result.current;

describe("hostReach", () => {
  it("is not away after one failure and away after two in a row", () => {
    noteReviewTransportFailure("t1");
    expect(cause()).toBeNull();
    noteReviewTransportFailure("t1");
    expect(cause()).toBe("host");
  });

  it("counts failures of requests that began before the last counted failure once", () => {
    const began = hostReachEpoch();
    noteReviewTransportFailure("t1", began);
    noteReviewTransportFailure("t1", began);
    expect(cause()).toBeNull();
    noteReviewTransportFailure("t1", hostReachEpoch());
    expect(cause()).toBe("host");
  });

  it("is away at once, for the device, when the browser reports no connection", () => {
    online = false;
    noteReviewTransportFailure("t1");
    expect(cause()).toBe("device");
  });

  it("clears on any answer and counts the return once", () => {
    const back = vi.fn();
    subscribeHostBack(back);
    const { result } = renderHook(() => ({
      cause: useHostCause("t1"),
      count: useHostBackCount("t1"),
    }));
    act(() => {
      noteReviewTransportFailure("t1");
      noteReviewTransportFailure("t1");
    });
    expect(result.current).toEqual({ cause: "host", count: 0 });
    act(() => noteReviewAnswer("t1"));
    expect(result.current).toEqual({ cause: null, count: 1 });
    act(() => noteReviewAnswer("t1"));
    expect(result.current.count).toBe(1);
    expect(back).toHaveBeenCalledOnce();
    expect(back).toHaveBeenCalledWith("t1");
  });

  it("restarts the count after an answer", () => {
    noteReviewTransportFailure("t1");
    noteReviewAnswer("t1");
    noteReviewTransportFailure("t1");
    expect(cause()).toBeNull();
  });

  it("follows the browser's line for the cause while away", () => {
    const { result } = renderHook(() => useHostCause("t1"));
    act(() => {
      noteReviewTransportFailure("t1");
      noteReviewTransportFailure("t1");
    });
    expect(result.current).toBe("host");
    online = false;
    act(() => void window.dispatchEvent(new Event("offline")));
    expect(result.current).toBe("device");
    online = true;
    act(() => void window.dispatchEvent(new Event("online")));
    expect(result.current).toBe("host");
  });

  it("resets when the token changes and reports nothing for another token", () => {
    noteReviewTransportFailure("t1");
    noteReviewTransportFailure("t1");
    expect(cause("t2")).toBeNull();
    noteReviewTransportFailure("t2");
    expect(cause("t1")).toBeNull();
    expect(cause("t2")).toBeNull();
  });

  describe("probing", () => {
    it("asks once after a lone failure, and goes away when the ask fails too", async () => {
      const probe = vi.fn(async () => {
        noteReviewTransportFailure("t1");
      });
      setHostReachProbe(probe);
      const unwatch = watchHostReach();
      noteReviewTransportFailure("t1");
      await vi.advanceTimersByTimeAsync(1600);
      expect(probe).toHaveBeenCalledOnce();
      expect(cause()).toBe("host");
      unwatch();
    });

    it("does not clear on an online event by itself, and clears when the probe is answered", async () => {
      let answered = false;
      setHostReachProbe(async () => {
        if (answered) noteReviewAnswer("t1");
        else noteReviewTransportFailure("t1");
      });
      const unwatch = watchHostReach();
      const { result } = renderHook(() => useHostCause("t1"));
      act(() => {
        noteReviewTransportFailure("t1");
        noteReviewTransportFailure("t1");
      });
      await act(async () => {
        window.dispatchEvent(new Event("online"));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current).toBe("host");
      answered = true;
      await act(async () => {
        window.dispatchEvent(new Event("online"));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current).toBeNull();
      unwatch();
    });

    it("keeps asking while away and stops once answered", async () => {
      const probe = vi.fn(async () => undefined);
      setHostReachProbe(probe);
      const unwatch = watchHostReach();
      noteReviewTransportFailure("t1");
      noteReviewTransportFailure("t1");
      expect(probe).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(11_000);
      expect(probe).toHaveBeenCalledTimes(3);
      noteReviewAnswer("t1");
      await vi.advanceTimersByTimeAsync(11_000);
      expect(probe).toHaveBeenCalledTimes(3);
      unwatch();
    });

    it("asks at once when the page turns away", () => {
      const probe = vi.fn(async () => undefined);
      setHostReachProbe(probe);
      const unwatch = watchHostReach();
      online = false;
      noteReviewTransportFailure("t1");
      expect(probe).toHaveBeenCalledOnce();
      unwatch();
    });

    it("stops asking and is no longer away when the last watcher leaves", async () => {
      const probe = vi.fn(async () => undefined);
      setHostReachProbe(probe);
      const unwatch = watchHostReach();
      noteReviewTransportFailure("t1");
      noteReviewTransportFailure("t1");
      expect(cause()).toBe("host");
      unwatch();
      expect(cause()).toBeNull();
      await vi.advanceTimersByTimeAsync(11_000);
      expect(probe).toHaveBeenCalledOnce();
    });

    it("asks nothing while no open page watches", async () => {
      const probe = vi.fn(async () => undefined);
      setHostReachProbe(probe);
      noteReviewTransportFailure("t1");
      noteReviewTransportFailure("t1");
      await vi.advanceTimersByTimeAsync(11_000);
      expect(probe).not.toHaveBeenCalled();
    });
  });
});
