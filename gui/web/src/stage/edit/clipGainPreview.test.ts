import { afterEach, describe, expect, it } from "vitest";
import { redisplayDrafts } from "../../document/applyDocumentUpdate";
import { useDawStore } from "../../state/dawStore";
import type { ProjectView } from "../../types/project";
import {
  endClipGainPreview,
  previewBaselineDb,
  showClipGainPreview,
} from "./clipGainPreview";

const clipGain = (id = "c1") =>
  useDawStore.getState().project?.clips.tracks.host?.find((c) => c.id === id)
    ?.gain_db;

function open(gain_db?: number) {
  const row = (id: string) => ({
    id,
    track_id: "host",
    ...(gain_db !== undefined ? { gain_db } : {}),
  });
  const project = {
    tracks: [],
    clips: { tracks: { host: [row("c1"), row("c2")] } },
  } as unknown as ProjectView;
  useDawStore.getState().setProject(project);
}

afterEach(() => {
  endClipGainPreview("c1", false);
  endClipGainPreview("c2", false);
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
    endClipGainPreview("c1", true);
    expect(clipGain()).toBe(2);
  });

  it("puts a 0 dB clip back to 0 dB", () => {
    open(0);
    showClipGainPreview("c1", 0, 9);
    endClipGainPreview("c1", true);
    expect(clipGain()).toBe(0);
  });

  it("keeps the shown gain when the save went through", () => {
    open();
    showClipGainPreview("c1", 0, 6);
    endClipGainPreview("c1", false);
    expect(clipGain()).toBe(6);
  });

  it("reports the gain from before the scrub as the baseline", () => {
    open(2);
    expect(previewBaselineDb("c1", 2)).toBe(2);
    showClipGainPreview("c1", 2, 9);
    showClipGainPreview("c1", 9, 10);
    expect(previewBaselineDb("c1", 10)).toBe(2);
    expect(previewBaselineDb("c2", 2)).toBe(2);
    endClipGainPreview("c1", true);
    expect(previewBaselineDb("c1", 2)).toBe(2);
  });

  it("puts the old clip back when a scrub moves to another clip", () => {
    open(1);
    showClipGainPreview("c1", 1, 8);
    showClipGainPreview("c2", 1, -4);
    expect(clipGain("c1")).toBe(1);
    expect(clipGain("c2")).toBe(-4);
  });

  it("puts a preview on another clip back even when asked to keep", () => {
    open(1);
    showClipGainPreview("c1", 1, 8);
    endClipGainPreview("c2", false);
    expect(clipGain("c1")).toBe(1);
  });

  it("leaves a gain that someone else changed during the scrub alone", () => {
    open(1);
    showClipGainPreview("c1", 1, 8);
    const project = useDawStore.getState().project!;
    useDawStore.getState().setProject({
      ...project,
      clips: {
        ...project.clips,
        tracks: {
          host: project.clips.tracks.host!.map((c) =>
            c.id === "c1" ? { ...c, gain_db: 5 } : c,
          ),
        },
      },
    });
    endClipGainPreview("c1", true);
    expect(clipGain()).toBe(5);
  });
});
