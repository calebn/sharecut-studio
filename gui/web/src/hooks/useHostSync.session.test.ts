import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { FakeWebSocket } from "../test/fakeWebSocket";
import { minimalProject } from "../test/fixtures";
import { useHostSync } from "./useHostSync";

vi.mock("../services/offlineQueue/requestDrainLazy", () => ({
  requestHostDrainLazy: vi.fn(),
}));
vi.mock("../api", () => ({
  loadSessionMeta: vi.fn(async () => ({
    path: "",
    mtime_ns: 0,
    size: 0,
    exists: false,
  })),
  loadSessionState: vi.fn(async () => null),
  postSessionState: vi.fn(async () => ({
    server_seq: 1,
    last_command_id: "cmd-1",
  })),
}));

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  FakeWebSocket.reset();
  useDawStore.getState().hydrate("/tmp/ep.project.json", minimalProject());
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("opens the host socket with no token in its URL when the page has no session token", async () => {
  renderHook(() =>
    useHostSync(
      "/tmp/ep.project.json",
      vi.fn(),
      () => ({ playhead_sec: 1, is_playing: false }),
      false,
      0,
      null,
      false,
      "k",
      true,
    ),
  );
  await act(async () => {
    await Promise.resolve();
  });

  const url = new URL(FakeWebSocket.instances[0].url);
  expect(url.pathname).toBe("/api/host/ws");
  expect([...url.searchParams.keys()].sort()).toEqual([
    "client_id",
    "document_client_id",
    "label",
    "path",
    "role",
  ]);
});
