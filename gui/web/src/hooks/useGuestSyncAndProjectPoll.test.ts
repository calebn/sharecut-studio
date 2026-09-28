import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDocumentSeqForTests } from "../document/cursor";
import { useDawStore } from "../state/dawStore";
import { FakeWebSocket } from "../test/fakeWebSocket";
import { minimalProject } from "../test/fixtures";
import { SANITY_POLL_MS } from "./useFileMetaPoll";
import { useGuestSyncAndProjectPoll } from "./useGuestSyncAndProjectPoll";

const loadProject = vi.fn();
const loadProjectMeta = vi.fn();

vi.mock("../api", () => ({
  loadProject: (...args: unknown[]) => loadProject(...args),
  loadProjectMeta: (...args: unknown[]) => loadProjectMeta(...args),
}));

vi.mock("../state/offlineStore", () => ({
  mergeOfflineSnapshot: vi.fn(async () => undefined),
}));

vi.mock("../state/drainOfflineQueue", () => ({
  drainOfflineQueue: vi.fn(async () => undefined),
}));

describe("useGuestSyncAndProjectPoll", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    FakeWebSocket.autoOpen = false;
    resetDocumentSeqForTests();
    loadProject.mockReset();
    loadProjectMeta.mockReset();
    loadProjectMeta.mockResolvedValue({ mtime_ns: 1, size: 1, server_seq: 0 });
    loadProject.mockResolvedValue(minimalProject());
    useDawStore.getState().hydrate("share:tok123", minimalProject());
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const metaCallsOver = async (ms: number) => {
    const before = loadProjectMeta.mock.calls.length;
    await vi.advanceTimersByTimeAsync(ms);
    return loadProjectMeta.mock.calls.length - before;
  };

  it("runs one project poll per tick for a guest whether its socket is connecting, open or closed", async () => {
    renderHook(() =>
      useGuestSyncAndProjectPoll(
        "share:tok123",
        vi.fn(),
        null,
        vi.fn(),
        vi.fn(),
        {
          hostSyncEnabled: false,
          guestSyncEnabled: true,
        },
      ),
    );
    expect(await metaCallsOver(1500)).toBe(1); // connecting: fallback poll only

    await act(async () => {
      FakeWebSocket.instances[0].open();
    });
    await vi.advanceTimersByTimeAsync(0); // useFileMetaPoll baseline read
    expect(await metaCallsOver(SANITY_POLL_MS)).toBe(1); // open: useProjectPoll only

    await act(async () => {
      FakeWebSocket.instances[0].close();
    });
    await vi.advanceTimersByTimeAsync(0); // fallback's immediate tick
    expect(await metaCallsOver(1500)).toBe(1); // closed: fallback poll only
  });

  it("runs useProjectPoll alone for a host", async () => {
    renderHook(() =>
      useGuestSyncAndProjectPoll("/p.json", vi.fn(), null, vi.fn(), vi.fn(), {
        hostSyncEnabled: true,
        guestSyncEnabled: false,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(await metaCallsOver(SANITY_POLL_MS)).toBe(1);
  });
});
