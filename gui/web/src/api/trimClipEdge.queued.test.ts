import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyDocumentSnapshot } from "../document/applyDocumentUpdate";
import { resetDocumentAuthority } from "../document/authorityState";
import { useDawStore } from "../state/dawStore";
import { deferred } from "../test/deferred";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import { trimClipEdge } from "./documentEdits";

const { enqueue, none } = vi.hoisted(() => {
  const none = async () => undefined;
  return {
    none,
    enqueue: async () => ({ persisted: true, hadPredecessor: false }),
  };
});
vi.mock("../services/offlineQueue/offlineStore", () => ({
  enqueueHostCommand: enqueue,
  enqueueCommand: enqueue,
  removeHostQueuedCommand: none,
  removeQueuedCommand: none,
  addHostConflict: none,
  addConflict: none,
  settleHostCommandOutcome: none,
  settleGuestCommandOutcome: none,
}));

const path = "/projects/trim.project.json";
const row = (id: string, track: string, tl: number, end: number) =>
  clipRow({
    id,
    track_id: track,
    timeline_start: tl,
    timeline_end: end,
    source_start: tl,
    source_end: end,
    source_duration_sec: 60,
  });
const base = minimalProject({
  project_path: path,
  tracks: [sampleTrack({ id: "host" }), sampleTrack({ id: "guest" })],
  clips: {
    tracks: {
      host: [row("h1", "host", 0, 10), row("h2", "host", 12, 20)],
      guest: [row("g1", "guest", 0, 20)],
    },
    clip_count: 3,
  },
});
const shown = () => {
  const tracks = useDawStore.getState().project?.clips.tracks ?? {};
  return Object.fromEntries(
    Object.entries(tracks).map(([id, lane]) => [
      id,
      lane.map((c) => [c.timeline_start, c.timeline_end]),
    ]),
  );
};
const saved = {
  host: [
    [0, 10],
    [12, 20],
  ],
  guest: [[0, 20]],
};
const trimmed = {
  host: [
    [0, 8],
    [10, 18],
  ],
  guest: [
    [0, 8],
    [8, 18],
  ],
};

beforeEach(() => {
  resetDocumentAuthority();
  useDawStore.getState().hydrate(path, base);
  applyDocumentSnapshot({ server_seq: 1, project: base });
});
afterEach(() => vi.unstubAllGlobals());

describe("a clip-edge trim shows its result before the server answers", () => {
  it("keeps an offline-queued trim where it was put", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
    expect(shown()).toEqual(saved);
    const result = await trimClipEdge(path, "h1", "out", 8, "ripple", "token");
    expect(result.queued).toBe(true);
    expect(shown()).toEqual(trimmed);
  });

  it("shows the trim while a slow save is in flight and drops it when the save is refused", async () => {
    const gate = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => gate.promise),
    );
    const saving = trimClipEdge(path, "h1", "out", 8, "ripple", "token");
    await Promise.resolve();
    expect(shown()).toEqual(trimmed);
    gate.resolve(
      new Response(JSON.stringify({ detail: "refused" }), { status: 409 }),
    );
    await expect(saving).rejects.toBeDefined();
    expect(shown()).toEqual(saved);
  });
});
