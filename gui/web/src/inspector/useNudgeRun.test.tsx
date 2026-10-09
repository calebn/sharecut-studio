import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type NudgeField, saveNudge } from "../edit/nudge";
import { useDawStore } from "../state/dawStore";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import { useNudgeRun } from "./useNudgeRun";

vi.mock("../edit/nudge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../edit/nudge")>()),
  saveNudge: vi.fn(async () => true),
}));
const field: NudgeField = {
  kind: "trim",
  trackId: "host",
  clipId: "anchor",
  edge: "out",
};
function Harness({ delta = -0.01 }: { delta?: number }) {
  const run = useNudgeRun();
  return <button {...run.buttonProps(field, delta, "Trim end")}>Nudge</button>;
}

describe("refused trim nudges", () => {
  beforeEach(() => {
    vi.mocked(saveNudge).mockClear();
  });
  it.each(["edited", "peer"])(
    "keeps and saves the last valid %s lane preview",
    async (placement) => {
      const anchor = clipRow({
        id: "anchor",
        source_end: 10,
        timeline_end: 10,
      });
      const follower = clipRow({
        id: "follower",
        track_id: placement === "edited" ? "host" : "guest",
        timeline_start: 0.015,
        timeline_end: 19.015,
        source_start: 0,
        source_end: 19,
        source_id: "alt",
        recording_key: "alt",
        fade_in_ms: 17,
      });
      const origin = minimalProject({
        tracks: [sampleTrack({ id: "host" }), sampleTrack({ id: "guest" })],
        clips: {
          tracks: {
            host: placement === "edited" ? [anchor, follower] : [anchor],
            guest:
              placement === "peer"
                ? [
                    clipRow({ ...anchor, id: "peer", track_id: "guest" }),
                    follower,
                  ]
                : [],
          },
          clip_count: placement === "peer" ? 3 : 2,
        },
      });
      useDawStore.getState().hydrate("/tmp/nudge.project.json", origin);
      const { getByRole } = render(<Harness />);
      const button = getByRole("button");
      fireEvent.keyDown(button, { key: "Enter" });
      const valid = useDawStore.getState().project;
      expect(
        valid?.clips.tracks[follower.track_id].find((c) => c.id === "follower"),
      ).toMatchObject({
        timeline_start: expect.closeTo(0.005, 9),
        source_start: 0,
        source_end: 19,
        fade_in_ms: 17,
      });
      fireEvent.keyDown(button, { key: "Enter", repeat: true });
      expect(useDawStore.getState().project).toBe(valid);
      expect(useDawStore.getState().statusAnnouncement).toContain(
        "before the timeline starts",
      );
      expect(saveNudge).not.toHaveBeenCalled();
      await act(async () => {
        fireEvent.keyUp(button, { key: "Enter" });
      });
      await waitFor(() => expect(saveNudge).toHaveBeenCalledOnce());
      expect(saveNudge).toHaveBeenCalledWith(
        "/tmp/nudge.project.json",
        origin,
        field,
        9.99,
      );
    },
  );
  it("classifies each accepted step from the saved lane", async () => {
    const anchor = clipRow({
      id: "anchor",
      source_start: 0,
      source_end: 10,
      timeline_end: 10,
    });
    const nested = clipRow({
      id: "nested",
      timeline_start: 1,
      timeline_end: 9,
      source_start: 0,
      source_end: 8,
      source_id: "alt",
      recording_key: "alt",
    });
    const origin = minimalProject({
      tracks: [sampleTrack({ id: "host" })],
      clips: { tracks: { host: [anchor, nested] }, clip_count: 2 },
    });
    useDawStore.getState().hydrate("/tmp/nudge.project.json", origin);
    const { getByRole } = render(<Harness delta={-1} />);
    const button = getByRole("button");
    fireEvent.keyDown(button, { key: "Enter" });
    fireEvent.keyDown(button, { key: "Enter", repeat: true });
    fireEvent.keyDown(button, { key: "Enter", repeat: true });
    expect(useDawStore.getState().project?.clips.tracks.host).toEqual([
      { ...anchor, source_end: 7, timeline_end: 7 },
      nested,
    ]);
    await act(async () => {
      fireEvent.keyUp(button, { key: "Enter" });
    });
    expect(saveNudge).toHaveBeenCalledWith(
      "/tmp/nudge.project.json",
      origin,
      field,
      7,
    );
  });
});
