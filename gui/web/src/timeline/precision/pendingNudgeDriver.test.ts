import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { refreshDocumentDisplay } from "../../document/applyDocumentUpdate";
import {
  documentAuthority,
  resetDocumentAuthority,
} from "../../document/authorityState";
import { currentDocumentSeq, noteDocumentSeq } from "../../document/cursor";
import {
  beginDocumentDraft,
  finishDocumentDraft,
} from "../../document/pendingDrafts";
import { type NudgeField, saveNudge, withNudge } from "../../edit/nudge";
import { useDawStore } from "../../state/dawStore";
import { deferred } from "../../test/deferred";
import {
  clipRow,
  minimalProject,
  pendingEditView,
  sampleTrack,
} from "../../test/fixtures";
import type { PendingEditView, ProjectView } from "../../types/project";
import { precisionDriver } from "./precisionDrivers";

const api = vi.hoisted(() => ({ updatePendingEdit: vi.fn() }));
vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  updatePendingEdit: api.updatePendingEdit,
}));

const PATH = "/tmp/pending-nudge.json";
const clipped = pendingEditView({
  id: "p1",
  track_id: "host",
  track_ids: ["host"],
  source_start: 20,
  source_end: 23.95,
  source_start_timeline: 20,
  source_end_timeline: 23.95,
  timeline_start: 20,
  timeline_end: 23.95,
  timeline_spans: [{ start: 20, end: 23.95 }],
});
const bare = pendingEditView({
  id: "p2",
  track_id: "empty",
  track_ids: ["empty"],
  source_start: 5,
  source_end: 8,
  source_start_timeline: 5,
  source_end_timeline: 8,
  timeline_start: 5,
  timeline_end: 8,
  timeline_spans: [{ start: 5, end: 8 }],
});
const withLabel = (label: string, edits = [clipped, bare]): ProjectView =>
  minimalProject({
    tracks: [
      sampleTrack({ id: "host", label, duration_sec: 60 }),
      sampleTrack({ id: "empty", duration_sec: 60 }),
    ],
    clips: {
      tracks: {
        host: [
          clipRow({
            id: "a",
            track_id: "host",
            source_start: 0,
            source_end: 10,
            timeline_start: 0,
            timeline_end: 10,
          }),
          clipRow({
            id: "c",
            track_id: "host",
            source_start: 12,
            source_end: 40,
            timeline_start: 12,
            timeline_end: 40,
          }),
        ],
        empty: [],
      },
      clip_count: 2,
    },
    pending_edits: edits,
  });
const project = withLabel("host");
type PendingField = Extract<NudgeField, { kind: "pending" }>;
const field = (id: string, edge: "start" | "end"): PendingField => ({
  kind: "pending",
  trackId: id === "p1" ? "host" : "empty",
  editId: id,
  edge,
});
const END = field("p1", "end");
const START = field("p1", "start");
const edit = (id = "p1"): PendingEditView => {
  const found = useDawStore
    .getState()
    .project?.pending_edits.find((e) => e.id === id);
  if (!found) throw new Error("no edit");
  return found;
};
const driver = (f: NudgeField) => {
  const made = precisionDriver(
    "pending-end",
    f.kind === "pending" ? f.editId : "",
    f,
    "End",
  );
  if (!made) throw new Error("no driver");
  return made;
};
const push = (next: ProjectView) => {
  documentAuthority.project = next;
  noteDocumentSeq(currentDocumentSeq() + 1);
  refreshDocumentDisplay();
};

beforeEach(() => {
  resetDocumentAuthority(PATH);
  useDawStore.getState().hydrate(PATH, project, null);
  documentAuthority.project = project;
  api.updatePendingEdit.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("pending nudge preview, as it behaves today", () => {
  it.each([
    ["clip end", END, 24.05],
    ["clip start", START, 20.5],
    ["identity end", field("p2", "end"), 8.5],
    ["identity start", field("p2", "start"), 5.5],
  ])("shows the %s as withNudge shows it", (_name, f, value) => {
    const drag = driver(f);
    expect(drag.begin()).toBe(true);
    drag.show(value);
    const id = f.kind === "pending" ? f.editId : "";
    expect(edit(id)).toEqual(
      withNudge(project, f, value).pending_edits.find((e) => e.id === id),
    );
    expect(edit(id)).not.toEqual(
      project.pending_edits.find((e) => e.id === id),
    );
    drag.cancel();
  });

  it("moves only the nudged edge and its span", () => {
    const drag = driver(END);
    drag.begin();
    drag.show(24.05);
    expect(edit()).toEqual({
      ...clipped,
      source_end: 24.05,
      source_end_timeline: 24.05,
      timeline_end: 24.05,
      timeline_spans: [{ start: 20, end: 24.05 }],
    });
    expect(edit("p2")).toEqual(bare);
    drag.cancel();
  });

  it("puts the saved range back on a cancel after a frame", () => {
    const drag = driver(END);
    drag.begin();
    drag.show(24.05);
    drag.cancel();
    expect(edit()).toEqual(clipped);
    expect(api.updatePendingEdit).not.toHaveBeenCalled();
  });

  it("saves the shown value once, with the baseline, and announces it", async () => {
    api.updatePendingEdit.mockResolvedValueOnce({ queued: false });
    const drag = driver(END);
    drag.begin();
    drag.show(24.05);
    await drag.commit();
    expect(api.updatePendingEdit).toHaveBeenCalledTimes(1);
    expect(api.updatePendingEdit).toHaveBeenCalledWith(
      PATH,
      "p1",
      20,
      24.05,
      false,
      undefined,
      {
        track_id: "host",
        type: "remove",
        timebase: "source",
        start: 20,
        end: 23.95,
      },
    );
    expect(useDawStore.getState().statusAnnouncement).toContain(
      "Pending edit timing saved",
    );
  });

  it("saves nothing when no frame was shown", async () => {
    const drag = driver(END);
    drag.begin();
    await drag.commit();
    expect(api.updatePendingEdit).not.toHaveBeenCalled();
    expect(edit()).toEqual(clipped);
  });

  it("reverts and announces a refused save, and stays silent after a project switch", async () => {
    api.updatePendingEdit.mockRejectedValueOnce(new Error("refused"));
    const drag = driver(END);
    drag.begin();
    drag.show(24.05);
    await drag.commit();
    expect(edit()).toEqual(clipped);
    expect(useDawStore.getState().statusAnnouncement).toContain(
      "End not saved: refused",
    );

    const refused = deferred<never>();
    api.updatePendingEdit.mockImplementationOnce(() => refused.promise);
    const again = driver(END);
    again.begin();
    again.show(24.05);
    const committing = again.commit();
    resetDocumentAuthority("/tmp/other.json");
    useDawStore.getState().hydrate("/tmp/other.json", project, null);
    const before = useDawStore.getState().statusAnnouncement;
    refused.reject(new Error("refused"));
    await committing;
    expect(useDawStore.getState().statusAnnouncement).toBe(before);
  });

  it("refuses to begin on an exact range, a split, null bounds or an unplaceable edge", () => {
    const refused = (e: PendingEditView) => {
      const next = withLabel("host", [e]);
      useDawStore.getState().hydrate(PATH, next, null);
      documentAuthority.project = next;
      const before = useDawStore.getState().project;
      const result = driver({ ...END, editId: e.id }).begin();
      expect(useDawStore.getState().project).toBe(before);
      return result;
    };
    expect(
      refused({
        ...clipped,
        exact_range: {
          kind: "exact_range",
          intervals: [{ start: 20, end: 23.95 }],
          track_ids: ["host"],
          clips: [],
          media_seals: {},
        },
      }),
    ).toBe(false);
    expect(refused({ ...clipped, type: "split" })).toBe(false);
    expect(refused({ ...clipped, source_start: null })).toBe(false);
    expect(refused({ ...clipped, source_end_timeline: 30 })).toBe(false);
  });

  it("saveNudge refuses a pending edit that is gone or has no bounds", async () => {
    await expect(
      saveNudge(
        PATH,
        project,
        { ...END, editId: "gone" },
        24,
        () => true,
        () => undefined,
      ),
    ).rejects.toThrow("The pending edit is gone.");
    const unbounded = withLabel("host", [{ ...clipped, source_end: null }]);
    await expect(
      saveNudge(
        PATH,
        unbounded,
        END,
        24,
        () => true,
        () => undefined,
      ),
    ).rejects.toThrow("The pending edit is gone.");
    expect(api.updatePendingEdit).not.toHaveBeenCalled();
  });

  it("today: a queued save snaps back to the saved range on the next refresh", async () => {
    api.updatePendingEdit.mockImplementationOnce(
      async (_path: string, id: string, start: number, end: number) => {
        beginDocumentDraft("cmd1", "UpdatePendingEdit", {
          id,
          start,
          end,
          snap: false,
        });
        return { queued: true, commandId: "cmd1" };
      },
    );
    const drag = driver(END);
    drag.begin();
    drag.show(24.05);
    await drag.commit();
    expect(edit().source_end).toBe(24.05);
    refreshDocumentDisplay();
    expect(edit()).toEqual(clipped);
    finishDocumentDraft("cmd1");
  });

  it("today: a push during the drag is overwritten by the next frame", () => {
    const drag = driver(END);
    drag.begin();
    drag.show(24.05);
    push(withLabel("renamed"));
    expect(useDawStore.getState().project?.tracks[0].label).toBe("renamed");
    drag.show(24.1);
    expect(useDawStore.getState().project?.tracks[0].label).toBe("host");
    expect(edit().source_end).toBe(24.1);
    drag.cancel();
  });
});
