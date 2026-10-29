import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { buildCommandContext, evaluateWhen } from "./context";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";

const PATH = "/tmp/ep/episode.sharecut";

function load(...tracks: Parameters<typeof sampleTrack>[0][]) {
  useDawStore
    .getState()
    .hydrate(
      PATH,
      minimalProject({ tracks: tracks.map((t) => sampleTrack(t)) }),
    );
}

describe("track.splitSpeakers", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    useDawStore.setState({ prepareFocusTrackId: null, selection: null });
  });

  afterEach(() => {
    clearRegisteredCommands();
  });

  it("opens Prepare at the split prompt for the track named in its args", async () => {
    load({ id: "room", media_path: "raw/room.wav" });
    expect(
      await execute(
        "track.splitSpeakers",
        { trackId: "room" },
        { skipWhen: true },
      ),
    ).toEqual({ status: "ok" });
    expect(useDawStore.getState().prepareFocusTrackId).toBe("room");
    expect(useDawStore.getState().stage).toBe("prepare");
  });

  it("falls back to the track the inspector shows", async () => {
    load({ id: "room", media_path: "raw/room.wav" });
    useDawStore.setState({ selection: { kind: "track", trackId: "room" } });
    expect(
      await execute("track.splitSpeakers", {}, { skipWhen: true }),
    ).toEqual({
      status: "ok",
    });
    expect(useDawStore.getState().prepareFocusTrackId).toBe("room");
  });

  it.each([
    [{ id: "room", media_path: null }, "Import this track's audio first"],
    [
      { id: "room", media_path: "raw/room.wav", speaker_split_id: "split_1" },
      "This track is already split by speaker. Undo the split to split it again.",
    ],
  ])("refuses a track that cannot be split: %#", async (track, reason) => {
    load(track);
    expect(
      await execute(
        "track.splitSpeakers",
        { trackId: "room" },
        { skipWhen: true },
      ),
    ).toEqual({ status: "disabled", reason });
    expect(useDawStore.getState().prepareFocusTrackId).toBeNull();
  });

  it("refuses without a track", async () => {
    load({ id: "room", media_path: "raw/room.wav" });
    expect(
      await execute("track.splitSpeakers", {}, { skipWhen: true }),
    ).toEqual({
      status: "disabled",
      reason: "Select a track to split",
    });
  });

  it("is offered in the palette only for a splittable inspector track", () => {
    load({ id: "room", media_path: "raw/room.wav" });
    expect(evaluateWhen("canSplitSpeakers", buildCommandContext())).toEqual({
      ok: false,
      reason: "Select a track to split",
    });
    useDawStore.setState({ selection: { kind: "track", trackId: "room" } });
    expect(evaluateWhen("canSplitSpeakers", buildCommandContext())).toEqual({
      ok: true,
    });
  });
});
