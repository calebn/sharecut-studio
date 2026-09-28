import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionClient } from "../types/session";
import { setServerClockOffsetForTests } from "./clock";
import { useLivePresenceClients } from "./useLivePresenceClients";

const T0 = 1_800_000_000_000;

function client(id: string, seenMs: number): SessionClient {
  return { client_id: id, role: "viewer", last_seen_ns: seenMs * 1e6 };
}

describe("useLivePresenceClients", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ticks while a remote client is live and stops once none is", () => {
    vi.useFakeTimers({ now: T0 });
    const clients = [client("me", T0), client("peer", T0)];
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useLivePresenceClients(clients, "me");
    });
    expect(result.current.nowMs).toBe(T0);
    expect(result.current.others.map((c) => c.client_id)).toEqual(["peer"]);
    const initial = renders;
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(renders).toBe(initial + 1);
    expect(result.current.nowMs).toBe(T0 + 5_000);
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(result.current.others).toEqual([]);
    const stopped = renders;
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(renders).toBe(stopped);
  });

  it("ignores the local client and schedules no tick for it", () => {
    vi.useFakeTimers({ now: T0 });
    const setIntervalSpy = vi.spyOn(window, "setInterval");
    const clients = [client("me", T0)];
    const { result } = renderHook(() => useLivePresenceClients(clients, "me"));
    expect(result.current.others).toEqual([]);
    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });

  it("lists no one before the local client id is known", () => {
    vi.useFakeTimers({ now: T0 });
    const clients = [client("peer", T0)];
    const { result } = renderHook(() => useLivePresenceClients(clients, null));
    expect(result.current.others).toEqual([]);
  });

  it("reads now from the server clock offset", () => {
    vi.useFakeTimers({ now: T0 });
    setServerClockOffsetForTests(1_000);
    const { result } = renderHook(() => useLivePresenceClients([], "me"));
    expect(result.current.nowMs).toBe(T0 + 1_000);
  });
});
