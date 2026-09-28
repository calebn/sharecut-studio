import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import {
  enqueueInbound,
  flushInbound,
  pendingInboundCount,
  resetInboundQueueForTests,
} from "./inboundQueue";

function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
}

describe("inboundQueue", () => {
  let rafSpy: ReturnType<typeof vi.spyOn>;
  let cafSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetInboundQueueForTests();
    setHidden(false);
    rafSpy = vi.spyOn(window, "requestAnimationFrame");
    cafSpy = vi.spyOn(window, "cancelAnimationFrame");
  });

  afterEach(() => {
    resetInboundQueueForTests();
    rafSpy.mockRestore();
    cafSpy.mockRestore();
    setHidden(false);
  });

  it("N enqueued jobs schedule one rAF and commit once", () => {
    const order: number[] = [];
    const listener = vi.fn();
    const unsub = useDawStore.subscribe(listener);
    enqueueInbound(() => {
      order.push(1);
      useDawStore.setState({ statusAnnouncement: "one" });
    });
    enqueueInbound(() => {
      order.push(2);
      useDawStore.setState({ statusAnnouncement: "two" });
    });
    enqueueInbound(() => {
      order.push(3);
      useDawStore.setState({ statusAnnouncement: "three" });
    });
    expect(rafSpy).toHaveBeenCalledTimes(1);
    flushInbound();
    unsub();
    expect(order).toEqual([1, 2, 3]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(useDawStore.getState().statusAnnouncement).toBe("three");
  });

  it("read-your-writes: a later job sees an earlier job's write in the same flush", () => {
    useDawStore.setState({ playheadSec: 0 });
    enqueueInbound(() => {
      useDawStore.setState({ playheadSec: 5 });
    });
    let seen = -1;
    enqueueInbound(() => {
      seen = useDawStore.getState().playheadSec;
    });
    flushInbound();
    expect(seen).toBe(5);
  });

  it("a matching coalesceKey replaces the pending job in its original slot", () => {
    const order: string[] = [];
    enqueueInbound(() => order.push("a"));
    enqueueInbound(() => order.push("presence-old"), {
      coalesceKey: "session:presence",
    });
    enqueueInbound(() => order.push("b"));
    enqueueInbound(() => order.push("presence-new"), {
      coalesceKey: "session:presence",
    });
    expect(pendingInboundCount()).toBe(3);
    flushInbound();
    expect(order).toEqual(["a", "presence-new", "b"]);
  });

  it("schedules a setTimeout(0) instead of rAF while the tab is hidden", () => {
    setHidden(true);
    const timeoutSpy = vi.spyOn(window, "setTimeout");
    enqueueInbound(() => {});
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 0);
    expect(rafSpy).not.toHaveBeenCalled();
    timeoutSpy.mockRestore();
  });

  it("switches a pending rAF flush to a timeout when the tab hides", () => {
    const timeoutSpy = vi.spyOn(window, "setTimeout");
    enqueueInbound(() => {});
    expect(rafSpy).toHaveBeenCalledTimes(1);
    expect(cafSpy).not.toHaveBeenCalled();
    setHidden(true);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(cafSpy).toHaveBeenCalledTimes(1);
    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 0);
    timeoutSpy.mockRestore();
  });

  it("a synchronous flushInbound() cancels the scheduled rAF", () => {
    enqueueInbound(() => {});
    expect(rafSpy).toHaveBeenCalledTimes(1);
    flushInbound();
    expect(cafSpy).toHaveBeenCalledTimes(1);
    expect(pendingInboundCount()).toBe(0);
  });

  it("a throwing job does not drop the rest of the batch", async () => {
    const ran: number[] = [];
    const microtaskSpy = vi
      .spyOn(globalThis, "queueMicrotask")
      .mockImplementation(() => {});
    enqueueInbound(() => {
      ran.push(1);
      throw new Error("bad frame");
    });
    enqueueInbound(() => {
      ran.push(2);
    });
    expect(() => flushInbound()).not.toThrow();
    expect(ran).toEqual([1, 2]);
    expect(microtaskSpy).toHaveBeenCalledTimes(1);
    // Let the deferred rethrow run (and be swallowed by vitest's uncaught
    // handler) instead of leaking into the next test.
    const rethrow = microtaskSpy.mock.calls[0]?.[0];
    microtaskSpy.mockRestore();
    expect(() => rethrow?.()).toThrow("bad frame");
  });

  it("a job enqueued during a flush runs on the next flush, not the current one", () => {
    const order: string[] = [];
    enqueueInbound(() => {
      order.push("first");
      enqueueInbound(() => order.push("second"));
    });
    flushInbound();
    expect(order).toEqual(["first"]);
    expect(pendingInboundCount()).toBe(1);
    flushInbound();
    expect(order).toEqual(["first", "second"]);
  });

  it("a re-entrant flushInbound() inside a job keeps the next flush scheduled", () => {
    const order: string[] = [];
    enqueueInbound(() => {
      order.push("first");
      enqueueInbound(() => order.push("second"));
      flushInbound();
    });
    flushInbound();
    expect(order).toEqual(["first"]);
    expect(pendingInboundCount()).toBe(1);
    // Only the outer flush cancelled the first rAF; the one armed mid-drain survives.
    expect(cafSpy).toHaveBeenCalledTimes(1);
    const next = rafSpy.mock.calls.at(-1)?.[0] as FrameRequestCallback;
    next(0);
    expect(order).toEqual(["first", "second"]);
  });
});
