import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadDocumentState } from "../api/project";
import { useDawStore } from "../state/dawStore";
import { minimalProject, sampleTrack } from "../test/fixtures";
import {
  applyDocumentResult,
  applyDocumentSnapshot,
  recoverDocument,
} from "./applyDocumentUpdate";
import {
  activateDocumentScope,
  documentAuthority,
  resetDocumentAuthority,
} from "./authorityState";
import { currentDocumentSeq, pollSnapshotAlreadyApplied } from "./cursor";
import { beginDocumentDraft, finishDocumentDraft } from "./pendingDrafts";
import type { DocumentSnapshot } from "./projectPatch";

vi.mock("../api/project", () => ({ loadDocumentState: vi.fn() }));
vi.mock("./hydrateTranscriptDetail", () => ({
  scheduleTranscriptDetailHydrate: vi.fn(),
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const token = "a".repeat(64);
const path = "/tmp/authority.json";
const initial = () =>
  minimalProject({
    project_path: path,
    tracks: [
      sampleTrack({ id: "a", label: "A" }),
      sampleTrack({ id: "b", label: "B" }),
    ],
  });
function labelDelta(base: number, label: string): DocumentSnapshot {
  return {
    server_seq: base + 1,
    state_token: token,
    file_before: { mtime_ns: base + 1, size: 1 },
    file: { mtime_ns: base + 2, size: 1 },
    delta: {
      base_seq: base,
      base_token: token,
      projection: "tracks",
      audience: "host",
      operations: [
        {
          type: "rows",
          section: "tracks",
          parent: null,
          before_count: 2,
          splices: [],
          updates: [{ index: 0, value: sampleTrack({ id: "a", label }) }],
        },
      ],
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  resetDocumentAuthority();
  useDawStore.getState().hydrate(path, initial());
  activateDocumentScope(path);
  applyDocumentSnapshot({
    server_seq: 0,
    state_token: token,
    project: initial(),
    file: { mtime_ns: 1, size: 1 },
  });
});
describe("one document authority", () => {
  it("applies HTTP before its WS echo exactly once and retains exact file provenance", () => {
    const snap = labelDelta(0, "Saved");
    applyDocumentResult({
      command: { command_id: "mine", server_seq: 1 },
      snapshot: snap,
    });
    const saved = documentAuthority.project;
    applyDocumentSnapshot(snap);
    expect(documentAuthority.project).toBe(saved);
    expect(currentDocumentSeq()).toBe(1);
    expect(
      pollSnapshotAlreadyApplied({ mtime_ns: 2, size: 1, server_seq: 1 }),
    ).toBe(true);
  });
  it("recovers once when own HTTP arrives ahead of its predecessor; newer frames only raise the required head", async () => {
    const request = deferred<DocumentSnapshot>();
    vi.mocked(loadDocumentState).mockReturnValue(request.promise);
    applyDocumentResult({
      command: { command_id: "mine", server_seq: 2 },
      snapshot: labelDelta(1, "Mine"),
    });
    applyDocumentSnapshot(labelDelta(2, "Peer"));
    expect(loadDocumentState).toHaveBeenCalledTimes(1);
    expect(currentDocumentSeq()).toBe(0);
    request.resolve({ server_seq: 3, project: initial() });
    await recoverDocument(3);
    expect(currentDocumentSeq()).toBe(3);
  });
  it("uses a retry replacement's current head while keeping the original command acknowledgment distinct", () => {
    const result = {
      server_seq: 1,
      command: { command_id: "retry", server_seq: 1 },
      snapshot: { server_seq: 4, project: initial() },
    };
    applyDocumentResult(result);
    expect(currentDocumentSeq()).toBe(4);
    expect(result.server_seq).toBe(1);
  });
  it("never applies positional updates to the optimistic reordered display", () => {
    beginDocumentDraft("reorder", "ReorderTrack", { track_id: "b", index: 0 });
    useDawStore.getState().setProject(initial());
    applyDocumentSnapshot(labelDelta(0, "Peer A"));
    expect(documentAuthority.project?.tracks.map((track) => track.id)).toEqual([
      "a",
      "b",
    ]);
    expect(
      useDawStore.getState().project?.tracks.map((track) => track.id),
    ).toEqual(["b", "a"]);
    expect(
      useDawStore.getState().project?.tracks.find((track) => track.id === "a")
        ?.label,
    ).toBe("Peer A");
    finishDocumentDraft("reorder");
    applyDocumentResult({
      command: { command_id: "reorder" },
      snapshot: {
        server_seq: 2,
        project: { ...initial(), tracks: [...initial().tracks].reverse() },
      },
    });
    expect(useDawStore.getState().project?.tracks[0].id).toBe("b");
  });
  it("rejects late snapshot, detail and command replies after leaving and returning to the same project", async () => {
    const oldScope = activateDocumentScope(path);
    const request = deferred<DocumentSnapshot>();
    vi.mocked(loadDocumentState).mockReturnValue(request.promise);
    const pending = recoverDocument(2, oldScope);
    resetDocumentAuthority("/tmp/other.json");
    resetDocumentAuthority(path);
    applyDocumentSnapshot({ server_seq: 0, project: initial() });
    request.resolve({
      server_seq: 2,
      project: minimalProject({ project_path: path, tracks: [] }),
    });
    await pending;
    applyDocumentResult(
      { snapshot: { server_seq: 3, project: minimalProject({ tracks: [] }) } },
      oldScope,
    );
    applyDocumentSnapshot(
      { server_seq: 0, patch: { tracks: [] } },
      { scope: oldScope, hydrationSeq: 0 },
    );
    expect(useDawStore.getState().project?.tracks).toHaveLength(2);
    expect(currentDocumentSeq()).toBe(0);
  });
  it("collapses continuous mix drafts and preserves the latest value over a peer update", () => {
    for (let i = 0; i < 500; i++)
      beginDocumentDraft(`fader${i}`, "SetTrackFader", {
        track_id: "a",
        fader_db: -i / 100,
      });
    finishDocumentDraft("fader0");
    applyDocumentSnapshot(labelDelta(0, "Peer"));
    expect(documentAuthority.project?.tracks[0].fader_db).not.toBe(-4.99);
    expect(useDawStore.getState().project?.tracks[0].fader_db).toBe(-4.99);
  });
  it("invalidates a captured scope synchronously across actual store navigation before React effects run", () => {
    const oldScope = activateDocumentScope(path);
    useDawStore.getState().hydrate("/tmp/other.json", minimalProject());
    useDawStore.getState().hydrate(path, initial());
    applyDocumentResult(
      {
        snapshot: {
          server_seq: 3,
          state_token: token,
          project: minimalProject({ tracks: [] }),
        },
      },
      oldScope,
    );
    expect(useDawStore.getState().project?.tracks).toHaveLength(2);
    expect(currentDocumentSeq()).toBe(0);
  });
});
