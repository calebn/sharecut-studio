import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { requestGuestDrainLazy } from "../services/offlineQueue/requestDrainLazy";
import { useDawStore } from "../state/dawStore";
import {
  noteReviewAnswer,
  noteReviewTransportFailure,
} from "../state/hostReach";
import { FakeWebSocket } from "../test/fakeWebSocket";
import { minimalProject } from "../test/fixtures";
import { useGuestSync } from "./useGuestSync";

const store = vi.hoisted(() => ({ queue: vi.fn(), outbox: vi.fn() }));

vi.mock("../api", () => ({ loadProjectMeta: vi.fn(async () => ({})) }));
vi.mock("../api/project", () => ({ loadDocumentState: vi.fn() }));
vi.mock("../services/offlineQueue/offlineStore", () => ({
  mergeOfflineSnapshot: vi.fn(async () => undefined),
  loadCommandQueue: store.queue,
}));
vi.mock("../state/outboxStore", () => ({
  loadOutbox: store.outbox,
  setOutboxDrainRequester: vi.fn(),
}));
vi.mock("../services/offlineQueue/requestDrainLazy", () => ({
  requestGuestDrainLazy: vi.fn(),
  requestHostDrainLazy: vi.fn(),
}));

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
  store.queue.mockReset();
  store.outbox.mockReset().mockResolvedValue([]);
  useDawStore.getState().hydrate("share:tok9", minimalProject());
  vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function hostLeavesAndReturns() {
  renderHook(() => useGuestSync("share:tok9", vi.fn(), vi.fn(), true));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  vi.mocked(requestGuestDrainLazy).mockClear();
  await act(async () => {
    noteReviewTransportFailure("tok9");
    noteReviewTransportFailure("tok9");
    noteReviewAnswer("tok9");
    await vi.advanceTimersByTimeAsync(0);
  });
}

it("sends what waited when the host answers again", async () => {
  store.queue.mockResolvedValue([{ command_id: "c1" }]);
  await hostLeavesAndReturns();
  expect(vi.mocked(requestGuestDrainLazy).mock.calls).toEqual([["tok9"]]);
});

it("starts no drain, so no Saving, when nothing waited", async () => {
  store.queue.mockResolvedValue([]);
  await hostLeavesAndReturns();
  expect(requestGuestDrainLazy).not.toHaveBeenCalled();
});

it("drains when the queue cannot be read, as the sanity timer would", async () => {
  store.queue.mockRejectedValue(new Error("idb"));
  await hostLeavesAndReturns();
  expect(vi.mocked(requestGuestDrainLazy).mock.calls).toEqual([["tok9"]]);
});

it("sends a kept comment when the host answers again, with no edit waiting", async () => {
  store.queue.mockResolvedValue([]);
  store.outbox.mockResolvedValue([{ id: "k1" }]);
  await hostLeavesAndReturns();
  expect(vi.mocked(requestGuestDrainLazy).mock.calls).toEqual([["tok9"]]);
});
