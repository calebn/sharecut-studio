import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadSessionMeta, loadSessionState } from "../api";
import { useDawStore } from "../state/dawStore";
import { deferred } from "../test/deferred";
import { FakeWebSocket } from "../test/fakeWebSocket";
import { minimalProject } from "../test/fixtures";
import type { SessionMeta, SessionState } from "../types/session";
import { useHostSync } from "./useHostSync";

vi.mock("../state/requestDrainLazy", () => ({ requestHostDrainLazy: vi.fn() }));
vi.mock("../api", () => ({
  loadSessionMeta: vi.fn(),
  loadSessionState: vi.fn(),
  postSessionState: vi.fn(),
}));

const PROJECT_A = "/tmp/host-lifetime-a.project.json";
const PROJECT_B = "/tmp/host-lifetime-b.project.json";

function meta(path: string, serverSeq = 0): SessionMeta {
  return {
    path,
    mtime_ns: serverSeq + 1,
    size: 1,
    exists: true,
    server_seq: serverSeq,
  };
}

function state(serverSeq: number, playheadSec: number): SessionState {
  return {
    version: 1,
    server_seq: serverSeq,
    origin: "agent",
    last_role: "agent",
    updated_at_ns: 0,
    last_command_id: `agent-${serverSeq}`,
    playhead_sec: playheadSec,
    is_playing: false,
    audition_mode: "mix",
    region: null,
    source: null,
    track_id: null,
    query: null,
    match_index: null,
    selection: null,
    viewer_mute: {},
    solo_tracks: {},
    tier: null,
    dry_run: false,
  };
}

function mount() {
  return renderHook(() => {
    const current = useDawStore();
    useHostSync(
      current.projectPath,
      current.applyAgentSession,
      () => ({}),
      true,
      current.lastAppliedRevision,
      current.lastAppliedCommandId,
      false,
      "lifetime-review",
    );
  });
}

beforeEach(() => {
  FakeWebSocket.reset();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  useDawStore.getState().hydrate(PROJECT_A, minimalProject());
  useDawStore.setState({
    lastAppliedRevision: 0,
    lastAppliedCommandId: null,
    playheadSec: 0,
  });
  vi.mocked(loadSessionMeta)
    .mockReset()
    .mockImplementation(async (path) => meta(path));
  vi.mocked(loadSessionState).mockReset().mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

it("accepts a lower session sequence after selecting another project", async () => {
  mount();
  await act(async () => {
    FakeWebSocket.instances[0].emit({
      plane: "session",
      type: "Snapshot",
      snapshot: state(50, 4),
    });
  });
  expect(useDawStore.getState().lastAppliedRevision).toBe(50);
  await act(async () => {
    useDawStore.getState().hydrate(PROJECT_B, minimalProject());
  });
  expect(useDawStore.getState().lastAppliedRevision).toBe(0);
  expect(useDawStore.getState().lastAppliedCommandId).toBeNull();
  await act(async () => {
    FakeWebSocket.instances[1].emit({
      plane: "session",
      type: "Snapshot",
      snapshot: state(1, 9),
    });
  });
  expect(useDawStore.getState().playheadSec).toBe(9);
  expect(useDawStore.getState().lastAppliedRevision).toBe(1);
});

it("restores the viewer's own presence identity after a project switch", async () => {
  mount();
  await act(async () => {
    await Promise.resolve();
  });
  const identity = useDawStore.getState().localClientId;
  expect(identity).toBeTruthy();
  await act(async () => {
    useDawStore.getState().hydrate(PROJECT_B, minimalProject());
  });
  expect(useDawStore.getState().localClientId).toBe(identity);
});

it.each([false, true])(
  "discards an old session-state reply after switching projects (return to original: %s)",
  async (returnToOriginal) => {
    const pending = deferred<SessionState | null>();
    vi.mocked(loadSessionState).mockReturnValueOnce(pending.promise);
    mount();
    await act(async () => {
      await Promise.resolve();
    });
    vi.mocked(loadSessionMeta).mockResolvedValueOnce(meta(PROJECT_A, 30));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(loadSessionState).toHaveBeenCalledWith(PROJECT_A);
    await act(async () => {
      useDawStore.getState().hydrate(PROJECT_B, minimalProject());
      if (returnToOriginal)
        useDawStore.getState().hydrate(PROJECT_A, minimalProject());
    });
    await act(async () => {
      pending.resolve(state(30, 99));
      await pending.promise;
    });
    expect(useDawStore.getState().playheadSec).toBe(0);
    expect(useDawStore.getState().lastAppliedRevision).toBe(0);
  },
);

it("retires an in-flight meta read and keeps the new project's poll baseline", async () => {
  const pending = deferred<SessionMeta>();
  mount();
  await act(async () => {
    await Promise.resolve();
  });
  vi.mocked(loadSessionMeta).mockReturnValueOnce(pending.promise);
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
  });
  await act(async () => {
    useDawStore.getState().hydrate(PROJECT_B, minimalProject());
    await Promise.resolve();
  });
  await act(async () => {
    pending.resolve(meta(PROJECT_A, 30));
    await pending.promise;
  });
  expect(loadSessionState).not.toHaveBeenCalled();
  vi.mocked(loadSessionMeta).mockResolvedValueOnce(meta(PROJECT_B, 1));
  vi.mocked(loadSessionState).mockResolvedValueOnce(state(1, 7));
  await act(async () => {
    window.dispatchEvent(new Event("focus"));
    await Promise.resolve();
  });
  expect(loadSessionState).toHaveBeenCalledExactlyOnceWith(PROJECT_B);
  expect(useDawStore.getState().playheadSec).toBe(7);
});
