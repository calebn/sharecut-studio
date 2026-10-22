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
import type { NudgeField } from "../../edit/nudge";
import { useDawStore } from "../../state/dawStore";
import { deferred } from "../../test/deferred";
import { minimalProject, sampleTrack } from "../../test/fixtures";
import { parseHistoryEntryId } from "../../types/project";
import { precisionDriver } from "./precisionDrivers";

const api = vi.hoisted(() => ({ setEnvelope: vi.fn() }));
vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  setEnvelope: api.setEnvelope,
}));

const PATH = "/tmp/precision.json";
const FIELD: NudgeField = {
  kind: "envelope-level",
  trackId: "host",
  pointId: "e1",
};
const project = minimalProject({
  tracks: [sampleTrack({ id: "host" })],
  envelopes: [
    {
      track_id: "host",
      parameter: "volume",
      points: [{ id: "e1", time: 5, value: 1 }],
    },
  ],
});
const level = () =>
  useDawStore.getState().project?.envelopes.find((e) => e.track_id === "host")
    ?.points[0]?.value;
const driver = () => {
  const made = precisionDriver("envelope", "e1", FIELD, "Level");
  if (!made) throw new Error("no driver");
  return made;
};

beforeEach(() => {
  resetDocumentAuthority(PATH);
  useDawStore.getState().hydrate(PATH, project, null);
  api.setEnvelope.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("precision drag of an envelope level (a draft preview)", () => {
  it("previews over the project, and a cancel puts the saved value back", () => {
    const drag = driver();
    expect(drag.begin()).toBe(true);
    drag.show(1.5);
    expect(level()).toBe(1.5);
    drag.cancel();
    expect(level()).toBe(1);
    expect(api.setEnvelope).not.toHaveBeenCalled();
  });

  it("does not let an earlier commit clear the preview of a newer drag", async () => {
    const saving = deferred<ReturnType<typeof parseHistoryEntryId>>();
    api.setEnvelope.mockReturnValueOnce(saving.promise);
    const first = driver();
    first.begin();
    first.show(1.5);
    const committing = first.commit();
    const second = driver();
    second.begin();
    second.show(1.8);
    saving.resolve(parseHistoryEntryId("h1"));
    await committing;
    expect(level()).toBe(1.8);
    // The first drag saved 1.5, so cancelling the second falls back to that.
    second.cancel();
    expect(level()).toBe(1.5);
  });

  it("leaves the preview alone when a cancel arrives while a commit is in flight", async () => {
    const saving = deferred<ReturnType<typeof parseHistoryEntryId>>();
    api.setEnvelope.mockReturnValueOnce(saving.promise);
    const drag = driver();
    drag.begin();
    drag.show(1.5);
    const committing = drag.commit();
    drag.cancel();
    expect(level()).toBe(1.5);
    saving.resolve(parseHistoryEntryId("h1"));
    await committing;
  });

  it("skips a frame it cannot hold instead of throwing, and saves only a value that was shown", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 256; i += 1) {
      const id = `fill-${i}`;
      ids.push(id);
      beginDocumentDraft(id, "SetTrackMute", {
        track_id: `t${i}`,
        muted: true,
      });
    }
    const drag = driver();
    drag.begin();
    expect(() => drag.show(1.5)).not.toThrow();
    expect(level()).toBe(1);
    await drag.commit();
    expect(api.setEnvelope).not.toHaveBeenCalled();
    for (const id of ids) finishDocumentDraft(id);
  });

  describe("after newer data arrives", () => {
    const withLabel = (label: string, value = 1) =>
      minimalProject({
        tracks: [sampleTrack({ id: "host", label })],
        envelopes: [
          {
            track_id: "host",
            parameter: "volume",
            points: [{ id: "e1", time: 5, value }],
          },
        ],
      });
    const push = (next: ReturnType<typeof withLabel>) => {
      documentAuthority.project = next;
      noteDocumentSeq(currentDocumentSeq() + 1);
      refreshDocumentDisplay();
    };
    beforeEach(() => {
      documentAuthority.project = project;
    });

    it("a cancel after an unrelated push shows the saved value", () => {
      const drag = driver();
      drag.begin();
      drag.show(1.5);
      push(withLabel("renamed"));
      expect(level()).toBe(1.5);
      drag.cancel();
      expect(level()).toBe(1);
    });

    it("a refused save after an unrelated push shows the saved value", async () => {
      api.setEnvelope.mockRejectedValueOnce(new Error("refused"));
      const drag = driver();
      drag.begin();
      drag.show(1.5);
      push(withLabel("renamed"));
      await drag.commit();
      expect(level()).toBe(1);
    });

    it("a frame after a push that changed the point shows the pushed value", () => {
      const drag = driver();
      drag.begin();
      drag.show(1.5);
      push(withLabel("peer", 2));
      drag.show(1.7);
      expect(level()).toBe(2);
      drag.cancel();
      expect(level()).toBe(2);
    });

    it("a newer drag stays shown through a refresh while an earlier commit is saving", async () => {
      const saving = deferred<ReturnType<typeof parseHistoryEntryId>>();
      api.setEnvelope.mockImplementationOnce(
        (_path: string, track: string, points: unknown) => {
          beginDocumentDraft("cmd1", "SetEnvelope", {
            track_id: track,
            points,
          });
          return saving.promise;
        },
      );
      const first = driver();
      first.begin();
      first.show(1.5);
      const committing = first.commit();
      const second = driver();
      second.begin();
      second.show(1.7);
      refreshDocumentDisplay();
      expect(level()).toBe(1.7);
      saving.resolve(parseHistoryEntryId("h1"));
      await committing;
      finishDocumentDraft("cmd1");
      second.cancel();
    });
  });
});
