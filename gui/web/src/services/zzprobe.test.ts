import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commandLocks } from "../test/commandLocks";

const store = {
  loadHostCommandQueue: vi.fn(async () => [] as unknown[]),
  enqueueHostCommand: vi.fn(async () => ({ persisted: true, hadPredecessor: false })),
  removeHostQueuedCommand: vi.fn(async () => {}),
  settleHostCommandOutcome: vi.fn(async () => {}),
  settleGuestCommandOutcome: vi.fn(async () => {}),
  enqueueCommand: vi.fn(async () => ({ persisted: true, hadPredecessor: false })),
  removeQueuedCommand: vi.fn(),
  removeHostConflictsWhere: vi.fn(async () => {}),
  removeConflictsWhere: vi.fn(async () => {}),
};
vi.mock("./offlineQueue/offlineStore", () => store);

const path = "/tmp/ep";
async function setup(fetchImpl: () => Promise<Response>) {
  vi.stubGlobal("fetch", vi.fn(fetchImpl));
  const { useDawStore } = await import("../state/dawStore");
  const { minimalProject, sampleTrack } = await import("../test/fixtures");
  const auth = await import("../document/authorityState");
  const upd = await import("../document/applyDocumentUpdate");
  const { clearRegisteredCommands, execute } = await import("../commands/execute");
  const mix = await import("../commands/trackMix");
  const proj = () => minimalProject({ tracks: [sampleTrack({ id: "host", gain_db: -2 })] });
  useDawStore.setState({ projectPath: path, guestMode: null, shareCapabilities: null, project: proj(), selection: { kind: "track", trackId: "host" } });
  auth.resetDocumentAuthority(path);
  auth.documentAuthority.path = path;
  auth.documentAuthority.project = proj();
  clearRegisteredCommands();
  mix.registerTrackMixCommands();
  const shown = () => useDawStore.getState().project?.tracks[0].muted;
  const server = (muted: boolean) => {
    auth.documentAuthority.project = { ...auth.documentAuthority.project!, tracks: [{ ...auth.documentAuthority.project!.tracks[0], muted }] };
    upd.refreshDocumentDisplay();
  };
  return { execute, shown, server, mix, auth, useDawStore };
}

describe("probe", () => {
  beforeEach(() => {
    Object.defineProperty(navigator, "locks", { configurable: true, value: commandLocks() });
    sessionStorage.clear();
    vi.resetModules();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("queued stays shown past snapshot", async () => {
    const t = await setup(async () => { throw new TypeError("offline"); });
    const r = await t.execute("track.muteToggle");
    expect(store.enqueueHostCommand).toHaveBeenCalled(); expect((r as any).status).toBe("ok");
    expect(t.shown()).toBe(true);
    t.server(false);
    expect(t.shown()).toBe(true);
    t.server(false);
    expect(t.shown()).toBe(true);
    await t.mix.flushPendingMix();
    t.server(false);
    expect(t.shown()).toBe(true);
  });

  it("failed send reverts", async () => {
    const t = await setup(async () => new Response(JSON.stringify({ ok: false, error: { code: "bad", message: "nope" } }), { status: 400, headers: { "content-type": "application/json" } }));
    const r = await t.execute("track.muteToggle");
    expect((r as any).status).toBe("disabled");
    expect(t.shown()).toBe(false);
    t.server(false);
    expect(t.shown()).toBe(false);
  });
});
