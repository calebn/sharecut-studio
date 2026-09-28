import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRosterRequester } from "./rosterRequest";

describe("createRosterRequester", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends one RosterRequest frame on request()", () => {
    const send = vi.fn();
    const requester = createRosterRequester(send);
    requester.request();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ type: "RosterRequest" });
  });

  it("does not send a second request while one is outstanding", () => {
    const send = vi.fn();
    const requester = createRosterRequester(send);
    requester.request();
    requester.request();
    requester.request();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("retries after the retry interval while still outstanding", () => {
    const send = vi.fn();
    const requester = createRosterRequester(send, 2000);
    requester.request();
    expect(send).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    expect(send).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(2000);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("onRosterReceived clears the outstanding flag and stops the retry", () => {
    const send = vi.fn();
    const requester = createRosterRequester(send, 2000);
    requester.request();
    requester.onRosterReceived();
    vi.advanceTimersByTime(10_000);
    expect(send).toHaveBeenCalledTimes(1);
    // A fresh request is allowed again.
    requester.request();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("dispose stops the retry without sending again", () => {
    const send = vi.fn();
    const requester = createRosterRequester(send, 2000);
    requester.request();
    requester.dispose();
    vi.advanceTimersByTime(10_000);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
