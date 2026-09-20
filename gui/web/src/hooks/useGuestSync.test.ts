import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDocumentSeqForTests } from "../document/cursor";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import type { ProjectView } from "../types/project";
import type { SessionState } from "../types/session";
import { useGuestSync } from "./useGuestSync";

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

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;
  closed = false;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
    this.onclose?.();
  }

  emit(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

describe("useGuestSync", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    resetDocumentSeqForTests();
    loadProject.mockReset();
    loadProjectMeta.mockReset();
    loadProjectMeta.mockResolvedValue({ mtime_ns: 1, size: 1, server_seq: 0 });
    loadProject.mockResolvedValue(minimalProject());
    useDawStore.getState().hydrate("share:tok123", minimalProject());
    useDawStore.getState().setActivityJob(null);
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal("window", {
      location: { protocol: "http:", host: "localhost:8765" },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
      setTimeout: vi.fn(() => 1),
      clearTimeout: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("connects to the guest daw ws and demuxes session vs document", async () => {
    const apply = vi.fn();
    const setProject = vi.fn();
    const setClients = vi.fn();
    const project = {
      meta: { name: "ep" },
      comments: [],
    } as unknown as ProjectView;

    renderHook(() =>
      useGuestSync(
        "share:tok123",
        apply,
        project,
        setProject,
        setClients,
        true,
      ),
    );

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toContain(
      "/api/review/tok123/daw/ws",
    );
    expect(FakeWebSocket.instances[0].url).toContain("client_id=");
    expect(FakeWebSocket.instances[0].url).toContain("name=");

    const sessionSnap = {
      type: "Snapshot",
      plane: "session",
      snapshot: {
        playhead_sec: 1.5,
        server_seq: 2,
        is_playing: false,
      } as SessionState,
    };
    await act(async () => {
      FakeWebSocket.instances[0].emit(sessionSnap);
    });
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ playhead_sec: 1.5 }),
    );

    const nextProject = minimalProject({
      meta: { name: "ep2", workspace_dir: "/tmp/test" },
    });
    await act(async () => {
      FakeWebSocket.instances[0].emit({
        type: "Applied",
        plane: "document",
        snapshot: {
          server_seq: 5,
          project: nextProject,
        },
      });
    });
    expect(useDawStore.getState().project?.meta.name).toBe("ep2");
  });

  it("applies Presence clients roster", async () => {
    const setClients = vi.fn();
    renderHook(() =>
      useGuestSync(
        "share:tok",
        vi.fn(),
        { meta: { name: "ep" }, comments: [] } as unknown as ProjectView,
        vi.fn(),
        setClients,
        true,
      ),
    );
    await act(async () => {
      FakeWebSocket.instances[0].emit({
        type: "Presence",
        plane: "session",
        clients: [{ client_id: "g1", role: "viewer", label: "Guest" }],
      });
    });
    expect(setClients).toHaveBeenCalledWith([
      { client_id: "g1", role: "viewer", label: "Guest" },
    ]);
  });

  it("adopts the server-assigned session client_id", async () => {
    renderHook(() =>
      useGuestSync(
        "share:tok123",
        vi.fn(),
        { meta: { name: "ep" }, comments: [] } as unknown as ProjectView,
        vi.fn(),
        vi.fn(),
        true,
      ),
    );
    expect(useDawStore.getState().localClientId).toBeNull();
    const url = FakeWebSocket.instances[0].url;
    expect(url).toContain("client_id=");
    expect(url).not.toContain("guest-");
    await act(async () => {
      FakeWebSocket.instances[0].emit({
        type: "Snapshot",
        plane: "session",
        client_id: "guest-tok123-viewerabc",
        snapshot: { playhead_sec: 0, server_seq: 1 } as SessionState,
      });
    });
    expect(useDawStore.getState().localClientId).toBe("guest-tok123-viewerabc");
    await act(async () => {
      FakeWebSocket.instances[0].emit({
        type: "Applied",
        plane: "document",
        client_id: "host-tab",
        snapshot: { server_seq: 2, comments: [] },
      });
    });
    expect(useDawStore.getState().localClientId).toBe("guest-tok123-viewerabc");
  });

  it("applies server_time_ns clock offset", async () => {
    renderHook(() =>
      useGuestSync(
        "share:tok",
        vi.fn(),
        { meta: { name: "ep" }, comments: [] } as unknown as ProjectView,
        vi.fn(),
        vi.fn(),
        true,
      ),
    );
    await act(async () => {
      FakeWebSocket.instances[0].emit({
        type: "Presence",
        server_time_ns: (Date.now() + 200) * 1e6,
        clients: [],
      });
    });
    expect(useDawStore.getState().serverClockOffsetMs).not.toBe(0);
  });

  it("merges comments when document snapshot has no project", async () => {
    const apply = vi.fn();
    const setProject = vi.fn();
    const project = minimalProject({
      comments: [{ id: "c1", body: "old" } as never],
    });
    useDawStore.getState().hydrate("share:tok", project);

    renderHook(() =>
      useGuestSync("share:tok", apply, project, setProject, vi.fn(), true),
    );

    await act(async () => {
      FakeWebSocket.instances[0].emit({
        type: "Applied",
        plane: "document",
        snapshot: {
          server_seq: 1,
          comments: [{ id: "c2", body: "hi" }],
        },
      });
    });
    expect(useDawStore.getState().project?.comments).toEqual([
      { id: "c2", body: "hi" },
    ]);
  });

  it("ignores older document server_seq", async () => {
    const setProject = vi.fn();
    renderHook(() =>
      useGuestSync(
        "share:tok",
        vi.fn(),
        { meta: { name: "ep" }, comments: [] } as unknown as ProjectView,
        setProject,
        vi.fn(),
        true,
      ),
    );

    await act(async () => {
      FakeWebSocket.instances[0].emit({
        type: "Applied",
        plane: "document",
        snapshot: {
          server_seq: 5,
          project: minimalProject({
            meta: { name: "a", workspace_dir: "/tmp" },
          }),
        },
      });
      FakeWebSocket.instances[0].emit({
        type: "Applied",
        plane: "document",
        snapshot: {
          server_seq: 3,
          project: minimalProject({
            meta: { name: "b", workspace_dir: "/tmp" },
          }),
        },
      });
    });
    expect(useDawStore.getState().project?.meta.name).toBe("a");
  });

  it("does not apply a fallback poll whose meta seq is behind document seq", async () => {
    let resolveMeta: (value: {
      mtime_ns: number;
      size: number;
      server_seq: number;
    }) => void = () => undefined;
    loadProjectMeta.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveMeta = resolve;
        }),
    );
    renderHook(() =>
      useGuestSync("share:tok123", vi.fn(), null, vi.fn(), vi.fn(), true),
    );
    await act(async () => {
      FakeWebSocket.instances[0].emit({
        type: "Applied",
        plane: "document",
        snapshot: {
          server_seq: 5,
          project: minimalProject({
            meta: { name: "from-ws", workspace_dir: "/tmp/test" },
          }),
        },
      });
    });
    await act(async () => {
      FakeWebSocket.instances[0].close();
    });
    await act(async () => {
      resolveMeta({ mtime_ns: 1, size: 1, server_seq: 3 });
    });
    expect(loadProject).not.toHaveBeenCalled();
    expect(useDawStore.getState().project?.meta.name).toBe("from-ws");
  });

  it("does not connect when disabled or non-share path", () => {
    renderHook(() =>
      useGuestSync("/local/path.json", vi.fn(), null, vi.fn(), vi.fn(), false),
    );
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("stores guest progress plane events as the activity job", async () => {
    renderHook(() =>
      useGuestSync(
        "share:tok123",
        vi.fn(),
        { meta: { name: "ep" }, comments: [] } as unknown as ProjectView,
        vi.fn(),
        vi.fn(),
        true,
      ),
    );
    await act(async () => {
      FakeWebSocket.instances[0].emit({
        type: "progress",
        plane: "progress",
        kind: "update",
        task_id: "guest_render_preview",
        label: "Render preview",
        message: "Mixing stems",
        status: "running",
        elapsed_sec: 2,
      });
    });
    const job = useDawStore.getState().activityJob;
    expect(job?.kind).toBe("agent");
    expect(job?.status).toBe("running");
    expect(job?.message).toBe("Mixing stems");
    expect(job?.project_path).toBe("");
  });
});
