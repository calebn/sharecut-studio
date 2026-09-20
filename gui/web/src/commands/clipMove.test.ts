import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import type { ClipRow, TrackView } from "../types/project";
import { clearRegisteredCommands, execute } from "./execute";
import {
  _resetTrackMutateChainForTests,
  registerDawCommands,
} from "./register";

vi.mock("../api", () => ({
  moveClips: vi.fn(async () => undefined),
}));

function track(id: string): TrackView {
  return {
    id,
    label: id,
    role: "dialogue",
    speaker: null,
    gain_db: 0,
    muted: false,
    duration_sec: 20,
    fx_count: 0,
    stem_is_fresh: true,
  };
}

function clip(id: string, trackId: string, start: number): ClipRow {
  return {
    id,
    track_id: trackId,
    source_start: 0,
    source_end: 2,
    timeline_start: start,
    timeline_end: start + 2,
    fade_in_ms: 0,
    fade_out_ms: 0,
    join_in_mode: "fade",
    source_id: null,
  };
}

describe("edit.moveClips", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    _resetTrackMutateChainForTests();
    vi.mocked(api.moveClips).mockClear();
    vi.mocked(api.moveClips).mockResolvedValue(undefined);
    useDawStore.getState().hydrate(
      "/tmp/ep",
      minimalProject({
        tracks: [track("host"), track("guest")],
        clips: {
          clip_count: 1,
          tracks: {
            host: [clip("c1", "host", 0)],
            guest: [],
          },
        },
      }),
    );
    useDawStore.setState({ guestMode: null, shareCapabilities: null });
  });

  it("patches then submits MoveClips", async () => {
    useDawStore.getState().setSelection({
      kind: "clip",
      id: "c1",
      trackId: "host",
    });
    const r = await execute(
      "edit.moveClips",
      {
        clips: [{ clip_id: "c1", timeline_start: 4, track_id: "guest" }],
      },
      { skipWhen: true },
    );
    expect(r.status).toBe("ok");
    expect(api.moveClips).toHaveBeenCalledWith("/tmp/ep", [
      { clip_id: "c1", timeline_start: 4, track_id: "guest" },
    ]);
    const moved = useDawStore
      .getState()
      .project?.clips.tracks.guest?.find((c) => c.id === "c1");
    expect(moved?.timeline_start).toBe(4);
    expect(moved?.origin_track_id).toBe("host");
    expect(useDawStore.getState().project?.clips.tracks.host).toEqual([]);
    expect(useDawStore.getState().selection).toEqual({
      kind: "clip",
      id: "c1",
      trackId: "guest",
    });
  });

  it("reverts the optimistic patch when the command fails", async () => {
    vi.mocked(api.moveClips).mockRejectedValueOnce(new Error("nope"));
    const before = useDawStore.getState().project;
    const r = await execute(
      "edit.moveClips",
      {
        clips: [{ clip_id: "c1", timeline_start: 9, track_id: "host" }],
      },
      { skipWhen: true },
    );
    expect(r.status).toBe("disabled");
    expect(useDawStore.getState().project).toBe(before);
  });
});
