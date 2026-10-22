import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDocumentAuthority } from "../../document/authorityState";
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
});
