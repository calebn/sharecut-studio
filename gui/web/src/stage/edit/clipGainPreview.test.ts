import { afterEach, describe, expect, it } from "vitest";
import { redisplayDrafts } from "../../document/applyDocumentUpdate";
import { useDawStore } from "../../state/dawStore";
import type { ProjectView } from "../../types/project";
import { endClipGainPreview, showClipGainPreview } from "./clipGainPreview";

const clipGain = () =>
  useDawStore.getState().project?.clips.tracks.host?.[0]?.gain_db;

function open(gain_db?: number) {
  const project = {
    tracks: [],
    clips: {
      tracks: {
        host: [{ id: "c1", track_id: "host", ...(gain_db ? { gain_db } : {}) }],
      },
    },
  } as unknown as ProjectView;
  useDawStore.getState().setProject(project);
}

afterEach(() => {
  endClipGainPreview(false, 0);
  redisplayDrafts();
});

describe("clip gain preview", () => {
  it("shows each scrubbed gain on the displayed clip", () => {
    open();
    showClipGainPreview("c1", 0, 6);
    expect(clipGain()).toBe(6);
    showClipGainPreview("c1", 6, -3.5);
    expect(clipGain()).toBe(-3.5);
  });

  it("puts the saved gain back when the scrub is cancelled", () => {
    open(2);
    showClipGainPreview("c1", 2, 9);
    endClipGainPreview(true, 9);
    expect(clipGain()).toBe(2);
  });

  it("keeps the shown gain when the save went through", () => {
    open();
    showClipGainPreview("c1", 0, 6);
    endClipGainPreview(false, 6);
    expect(clipGain()).toBe(6);
  });
});
