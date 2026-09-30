import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyDocumentSnapshot } from "../document/applyDocumentUpdate";
import { resetDocumentSeqForTests } from "../document/cursor";
import { useDawStore } from "../state/dawStore";
import { flushInbound } from "../sync/inboundQueue";
import { FakeWebSocket } from "../test/fakeWebSocket";
import { minimalProject } from "../test/fixtures";
import { useHostSync } from "./useHostSync";

vi.mock("../state/requestDrainLazy", () => ({ requestHostDrainLazy: vi.fn() }));
vi.mock("../api", () => ({
  loadSessionMeta: vi.fn(async () => ({ exists: false })),
  loadSessionState: vi.fn(async () => null),
  postSessionState: vi.fn(),
}));
const token = "a".repeat(64);
const snapshot = () => ({
  server_seq: 1,
  state_token: token,
  project: minimalProject(),
});
const session = {
  plane: "session",
  type: "Snapshot",
  snapshot: { server_seq: 1, last_command_id: null, origin: "viewer" },
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  FakeWebSocket.reset({ autoOpen: false });
  vi.stubGlobal("WebSocket", FakeWebSocket);
  resetDocumentSeqForTests();
  useDawStore.getState().hydrate("/tmp/retry.json", minimalProject());
  applyDocumentSnapshot(snapshot());
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function mount() {
  return renderHook(() =>
    useHostSync(
      "/tmp/retry.json",
      vi.fn(),
      () => ({}),
      true,
      0,
      null,
      false,
      "retry",
    ),
  );
}
it("grows retry delay across open sockets until both initial planes have applied", async () => {
  const hook = mount();
  act(() => {
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].close();
  });
  act(() => {
    vi.advanceTimersByTime(249);
  });
  expect(FakeWebSocket.instances).toHaveLength(1);
  act(() => {
    vi.advanceTimersByTime(1);
  });
  const second = FakeWebSocket.instances[1];
  act(() => {
    second.open();
    second.emit(session);
    second.close();
    vi.advanceTimersByTime(499);
  });
  expect(FakeWebSocket.instances).toHaveLength(2);
  act(() => {
    vi.advanceTimersByTime(1);
  });
  const third = FakeWebSocket.instances[2];
  act(() => {
    third.open();
    third.deliver(session);
    third.deliver({
      plane: "document",
      type: "Snapshot",
      snapshot: snapshot(),
    });
  });
  act(() => {
    flushInbound();
    third.close();
    vi.advanceTimersByTime(249);
  });
  expect(FakeWebSocket.instances).toHaveLength(3);
  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(FakeWebSocket.instances).toHaveLength(4);
  hook.unmount();
  await act(async () => {
    await Promise.resolve();
  });
});
it("does not treat queued hello frames from a retired socket as initialization", () => {
  const hook = mount();
  act(() => {
    FakeWebSocket.instances[0].close();
    vi.advanceTimersByTime(250);
  });
  const second = FakeWebSocket.instances[1];
  act(() => {
    second.open();
    second.deliver(session);
    second.deliver({
      plane: "document",
      type: "Snapshot",
      snapshot: snapshot(),
    });
    second.close();
    flushInbound();
    vi.advanceTimersByTime(499);
  });
  expect(FakeWebSocket.instances).toHaveLength(2);
  act(() => {
    vi.advanceTimersByTime(1);
  });
  expect(FakeWebSocket.instances).toHaveLength(3);
  hook.unmount();
});
