import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyDocumentSnapshot,
  refreshDocumentDisplay,
} from "../document/applyDocumentUpdate";

import { resetDocumentAuthority } from "../document/authorityState";
import { beginDocumentDraft } from "../document/pendingDrafts";
import { useDawStore } from "../state/dawStore";
import { deferred } from "../test/deferred";
import { minimalProject, pendingEditView } from "../test/fixtures";
import { updatePendingEdit } from "./documentEdits";

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

const path = "/projects/pending.project.json";
const saved = pendingEditView({
  id: "p1",
  track_id: "host",
  source_start: 20,
  source_end: 24,
  source_start_timeline: 20,
  source_end_timeline: 24,
  timeline_start: 20,
  timeline_end: 24,
  timeline_spans: [{ start: 20, end: 24 }],
});
const base = minimalProject({ project_path: path, pending_edits: [saved] });
const shown = () => {
  const edit = useDawStore.getState().project?.pending_edits[0];
  return [edit?.source_start, edit?.source_end, edit?.timeline_end];
};

beforeEach(() => {
  resetDocumentAuthority();
  useDawStore.getState().hydrate(path, base);
  applyDocumentSnapshot({ server_seq: 1, project: base });
});
afterEach(() => vi.unstubAllGlobals());

describe("a pending-edit range save shows its value before the server answers", () => {
  it("keeps an offline-queued save on screen, and the next save starts from it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
    expect(await updatePendingEdit(path, "p1", 20, 25, false)).toMatchObject({
      queued: true,
    });
    expect(shown()).toEqual([20, 25, 25]);
    const edit = useDawStore.getState().project?.pending_edits[0];
    await updatePendingEdit(path, "p1", 19, edit?.source_end ?? 0, false);
    expect(shown()).toEqual([19, 25, 25]);
  });

  it("shows the value while a slow save is in flight and drops it when the save is refused", async () => {
    const gate = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => gate.promise),
    );
    const saving = updatePendingEdit(path, "p1", 20, 25, false);
    await Promise.resolve();
    expect(shown()).toEqual([20, 25, 25]);
    gate.resolve(
      new Response(JSON.stringify({ detail: "refused" }), { status: 409 }),
    );
    await expect(saving).rejects.toBeDefined();
    expect(shown()).toEqual([20, 24, 24]);
  });

  it("keeps a start save held after a refresh when an end save queued after it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
    await updatePendingEdit(path, "p1", 21, 24, false);
    await updatePendingEdit(path, "p1", 21, 30, false);
    await updatePendingEdit(path, "p1", 26, 30, false);
    expect(shown()).toEqual([26, 30, 30]);
    refreshDocumentDisplay();
    expect(shown()).toEqual([26, 30, 30]);
  });

  it("does not redisplay for a project that is not the open one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
    beginDocumentDraft("held", "UpdatePendingEdit", {
      id: "p1",
      start: 20,
      end: 25,
      snap: false,
    });
    await updatePendingEdit(
      "/projects/other.project.json",
      "p1",
      20,
      25,
      false,
    );
    expect(shown()).toEqual([20, 24, 24]);
  });
});
