import { describe, expect, it } from "vitest";
import { beginHostSend, isHostSendInFlight } from "./hostSendOrder";

describe("hostSendOrder", () => {
  it("reports a command in flight until it finishes", () => {
    const send = beginHostSend("/p", "a");
    expect(isHostSendInFlight("/p", "a")).toBe(true);
    expect(isHostSendInFlight("/q", "a")).toBe(false);
    send.finish();
    expect(isHostSendInFlight("/p", "a")).toBe(false);
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
});
