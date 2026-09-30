import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeWebSocket } from "../test/fakeWebSocket";
import { sampleComment } from "../test/fixtures";
import { useGuestProgress } from "./useGuestProgress";

const frame = (body: string, revision = "a".repeat(32)) => ({
  plane: "comments",
  type: "Snapshot",
  revision,
  comments: [sampleComment({ body })],
});
beforeEach(() => {
  FakeWebSocket.reset({ autoOpen: false });
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("light review connection", () => {
  it("initializes comments, preserves progress and rejects an unknown predecessor", async () => {
    const hook = renderHook(() => useGuestProgress("token"));
    const socket = FakeWebSocket.instances[0];
    await act(async () => socket.open());
    expect(hook.result.current.healthy).toBe(false);
    await act(async () => socket.emit(frame("Current")));
    expect(hook.result.current.healthy).toBe(true);
    await act(async () =>
      socket.emit({
        plane: "progress",
        type: "progress",
        task_id: "mine",
        status: "running",
        message: "Working",
      }),
    );
    expect(hook.result.current.job?.message).toBe("Working");
    expect(hook.result.current.comments?.[0].body).toBe("Current");
    await act(async () =>
      socket.emit({
        plane: "comments",
        type: "Applied",
        revision: "b".repeat(32),
        previous_revision: "wrong",
        operations: {},
      }),
    );
    expect(socket.closed).toBe(true);
    expect(hook.result.current.healthy).toBe(false);
    await act(async () => vi.advanceTimersByTime(2000));
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
  it("stops reconnecting after revocation and rejects late frames", async () => {
    const hook = renderHook(() => useGuestProgress("token"));
    const socket = FakeWebSocket.instances[0];
    await act(async () => {
      socket.open();
      socket.emit(frame("Before"));
      socket.close(4403);
    });
    expect(hook.result.current.healthy).toBe(false);
    expect(hook.result.current.error).toBe(
      "This review link is no longer available.",
    );
    await act(async () => {
      socket.emit(frame("Late"));
      vi.advanceTimersByTime(4000);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(hook.result.current.comments).toBeNull();
  });
  it("invalidates old token sockets across ABA and starts from a fresh replacement", async () => {
    const hook = renderHook(({ token }) => useGuestProgress(token), {
      initialProps: { token: "A" },
    });
    const first = FakeWebSocket.instances[0];
    await act(async () => {
      first.open();
      first.emit(frame("Old A"));
    });
    hook.rerender({ token: "B" });
    hook.rerender({ token: "A" });
    expect(hook.result.current.comments).toBeNull();
    expect(first.closed).toBe(true);
    await act(async () => first.emit(frame("Late A")));
    expect(hook.result.current.comments).toBeNull();
    const current = FakeWebSocket.instances[2];
    await act(async () => {
      current.open();
      current.emit(frame("New A"));
    });
    expect(hook.result.current.comments?.[0].body).toBe("New A");
    hook.unmount();
    expect(current.closed).toBe(true);
  });
});
