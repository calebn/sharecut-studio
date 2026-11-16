import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyDocumentSnapshot } from "../document/applyDocumentUpdate";
import { resetDocumentAuthority } from "../document/authorityState";
import {
  hasDocumentDrafts,
  overlayDocumentDrafts,
} from "../document/pendingDrafts";
import { useDawStore } from "../state/dawStore";
import { minimalProject, pendingEditView } from "../test/fixtures";
import { submitQueuedDocumentCommand } from "./commandQueue";

const { enqueue, remove, settle } = vi.hoisted(() => {
  const remove = async () => undefined;
  const enqueue = async () => ({ persisted: true, hadPredecessor: false });
  return { enqueue, remove, settle: async () => undefined };
});
vi.mock("./offlineQueue/offlineStore", () => ({
  enqueueHostCommand: enqueue,
  enqueueCommand: enqueue,
  removeHostQueuedCommand: remove,
  removeQueuedCommand: remove,
  addHostConflict: remove,
  addConflict: remove,
  settleHostCommandOutcome: settle,
  settleGuestCommandOutcome: settle,
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
const payload = {
  id: "p1",
  start: 20,
  end: 25,
  snap: false,
  expected: {
    track_id: "host",
    type: "remove",
    timebase: "source",
    start: 20,
    end: 24,
  },
};
const submit = () =>
  submitQueuedDocumentCommand(path, "UpdatePendingEdit", payload);

beforeEach(() => {
  resetDocumentAuthority();
  useDawStore.getState().hydrate(path, base);
  applyDocumentSnapshot({ server_seq: 1, project: base });
});
afterEach(() => vi.unstubAllGlobals());

describe("a pending-edit range save through the command queue", () => {
  it("keeps its draft while the save is queued", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
    const result = await submit();
    expect(result.queued).toBe(true);
    expect(hasDocumentDrafts()).toBe(true);
    expect(overlayDocumentDrafts(base).pending_edits[0].source_end).toBe(25);
  });

  it.each([
    ["a 409 refusal", 409],
    ["a client error", 400],
  ])("clears its draft on %s", async (_name, status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ detail: "refused" }), { status }),
      ),
    );
    await expect(submit()).rejects.toBeDefined();
    expect(hasDocumentDrafts()).toBe(false);
    expect(overlayDocumentDrafts(base)).toBe(base);
  });
});
