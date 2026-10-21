import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { requestGuestDrainLazy } from "../services/offlineQueue/requestDrainLazy";
import { useDawStore } from "../state/dawStore";
import { SANITY_POLL_MS } from "../state/syncCadence";
import { FakeWebSocket } from "../test/fakeWebSocket";
import { minimalProject } from "../test/fixtures";
import { useGuestSync } from "./useGuestSync";

vi.mock("../api", () => ({ loadProjectMeta: vi.fn(async () => ({})) }));
vi.mock("../api/project", () => ({ loadDocumentState: vi.fn() }));
vi.mock("../state/offlineStore", () => ({
  mergeOfflineSnapshot: vi.fn(async () => undefined),
}));
vi.mock("../services/offlineQueue/requestDrainLazy", () => ({
  requestGuestDrainLazy: vi.fn(),
  requestHostDrainLazy: vi.fn(),
}));

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
  useDawStore.getState().hydrate("share:tok123", minimalProject());
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("retries the guest queue on the sanity cadence while the socket stays open", async () => {
  renderHook(() => useGuestSync("share:tok123", vi.fn(), vi.fn(), true));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(vi.mocked(requestGuestDrainLazy).mock.calls).toEqual([["tok123"]]);

  await act(async () => {
    await vi.advanceTimersByTimeAsync(SANITY_POLL_MS);
  });

  expect(vi.mocked(requestGuestDrainLazy).mock.calls).toEqual([
    ["tok123"],
    ["tok123"],
  ]);
});
