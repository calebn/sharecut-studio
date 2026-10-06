import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TunnelState } from "../types/tunnel";
import { TUNNEL_STATUS_POLL_MS, useTunnelStatus } from "./useTunnelStatus";

function reply(state: TunnelState) {
  return {
    ok: true,
    json: async () => ({
      state,
      reason: null,
      reason_kind: null,
      relay_host: "relay.example.test",
      public_base_url: "https://share.example.test",
      share_count: 2,
      attempt: 0,
      retry_in_sec: null,
    }),
  };
}

describe("useTunnelStatus", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("follows Online, Reconnecting, then Offline as the tunnel drops and gives up", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(reply("online"))
      .mockResolvedValueOnce(reply("reconnecting"))
      .mockResolvedValue(reply("offline"));
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useTunnelStatus(true));
    expect(result.current).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current?.state).toBe("online");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/tunnel/status",
      expect.anything(),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TUNNEL_STATUS_POLL_MS);
    });
    expect(result.current?.state).toBe("reconnecting");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(TUNNEL_STATUS_POLL_MS);
    });
    expect(result.current?.state).toBe("offline");
  });

  it("does not fetch while disabled and clears a stale answer when turned off", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reply("online"));
    vi.stubGlobal("fetch", fetchMock);

    const { result, rerender } = renderHook(
      ({ enabled }) => useTunnelStatus(enabled),
      { initialProps: { enabled: false } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TUNNEL_STATUS_POLL_MS * 2);
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current).toBeNull();

    rerender({ enabled: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current?.state).toBe("online");

    rerender({ enabled: false });
    expect(result.current).toBeNull();
    const calls = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TUNNEL_STATUS_POLL_MS * 2);
    });
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it("hides the indicator when the status cannot be read", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(reply("online"))
        .mockResolvedValue({
          ok: false,
          status: 500,
          text: async () => "",
          json: async () => ({}),
        }),
    );
    const { result } = renderHook(() => useTunnelStatus(true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current?.state).toBe("online");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TUNNEL_STATUS_POLL_MS);
    });
    expect(result.current).toBeNull();
  });
});
