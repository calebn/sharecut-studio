import { describe, expect, it, vi } from "vitest";
import {
  beginHostSend,
  hostSendDone,
  hostSendsFinished,
} from "./hostSendOrder";

describe("hostSendOrder", () => {
  it("exposes a command's in-flight send until it finishes", async () => {
    const send = beginHostSend("/p", "a");
    expect(hostSendDone("/p", "a")).not.toBeNull();
    expect(hostSendDone("/q", "a")).toBeNull();
    const done = hostSendDone("/p", "a") as Promise<void>;
    send.finish();
    await done;
    expect(hostSendDone("/p", "a")).toBeNull();
  });

  it("earlierWithin reports true when earlier sends finish in time", async () => {
    const first = beginHostSend("/p", "a");
    const second = beginHostSend("/p", "b");
    const within = second.earlierWithin(1000);
    first.finish();
    await expect(within).resolves.toBe(true);
    second.finish();
  });

  it("earlierWithin gives up on a stalled earlier send", async () => {
    vi.useFakeTimers();
    try {
      const first = beginHostSend("/p", "a");
      const second = beginHostSend("/p", "b");
      const within = second.earlierWithin(1000);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(within).resolves.toBe(false);
      first.finish();
      second.finish();
    } finally {
      vi.useRealTimers();
    }
  });

  it("makes a later send wait for earlier ones", async () => {
    const first = beginHostSend("/p", "a");
    const second = beginHostSend("/p", "b");
    let settled = false;
    void second.earlier.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    first.finish();
    await second.earlier;
    expect(settled).toBe(true);
    second.finish();
  });

  it("does not make an earlier send wait on later ones", async () => {
    const first = beginHostSend("/p", "a");
    const second = beginHostSend("/p", "b");
    await first.earlier;
    first.finish();
    second.finish();
  });

  it("counts finished sends per project", () => {
    const before = hostSendsFinished("/count");
    const send = beginHostSend("/count", "a");
    expect(hostSendsFinished("/count")).toBe(before);
    send.finish();
    expect(hostSendsFinished("/count")).toBe(before + 1);
    expect(hostSendsFinished("/other-count")).toBe(0);
  });
});
