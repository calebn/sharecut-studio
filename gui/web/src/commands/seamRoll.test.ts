import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { useDawStore } from "../state/dawStore";
import {
  clipRow,
  editBoundaries,
  minimalProject,
  sampleTrack,
} from "../test/fixtures";
import { ROLL_QUEUED_MESSAGE } from "./seamCommands";
import { commitSeamRoll, seamRollLimits } from "./seamRoll";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  loadBoundaryContext: vi.fn(async () => ({ token: "ctx-token" })),
  rollClipJoin: vi.fn(async () => ({ queued: false })),
}));

const TRACK = "mira-voice";
const L = clipRow({
  id: "L",
  source_start: 0,
  source_end: 4,
  source_duration_sec: 20,
  timeline_start: 0,
  timeline_end: 4,
});
const R = clipRow({
  id: "R",
  source_start: 4,
  source_end: 10,
  timeline_start: 4,
  timeline_end: 10,
});

beforeEach(() => {
  vi.mocked(api.rollClipJoin).mockClear();
  useDawStore.setState({
    project: minimalProject({
      tracks: [sampleTrack({ id: TRACK })],
      clips: { tracks: { [TRACK]: [L, R] }, clip_count: 2 },
      edit_boundaries: editBoundaries([L, R]),
    }),
    projectPath: "/tmp/episode",
    guestMode: null,
    shareCapabilities: null,
    joinMutationInFlight: false,
  });
});

describe("seamRollLimits and commitSeamRoll", () => {
  it("reads the room the clips leave, in milliseconds", () => {
    const limits = seamRollLimits("eb:L:R");
    expect(limits).toEqual({ minMs: -3950, maxMs: 5950 });
  });

  it("has no limits for a missing seam or while another seam save runs", () => {
    expect(seamRollLimits("eb:L:missing")).toBeNull();
    useDawStore.setState({ joinMutationInFlight: true });
    expect(seamRollLimits("eb:L:R")).toBeNull();
  });

  it("rolls the seam by id and says nothing on success", async () => {
    const say = vi.fn();
    await commitSeamRoll("eb:L:R", 20, say);
    expect(api.rollClipJoin).toHaveBeenCalledTimes(1);
    expect(say).not.toHaveBeenCalled();
  });

  it("says a failed save, and that a queued one waits for the connection", async () => {
    const say = vi.fn();
    vi.mocked(api.rollClipJoin).mockRejectedValueOnce(new Error("boom"));
    await commitSeamRoll("eb:L:R", 20, say);
    expect(say).toHaveBeenLastCalledWith("Could not roll the seam. boom");
    vi.mocked(api.rollClipJoin).mockResolvedValueOnce({ queued: true });
    await commitSeamRoll("eb:L:R", 20, say);
    expect(say).toHaveBeenLastCalledWith(ROLL_QUEUED_MESSAGE);
  });

  it("saves a roll on the clips it was started on, with their geometry", async () => {
    await commitSeamRoll("eb:L:R", 100, vi.fn());
    expect(api.loadBoundaryContext).toHaveBeenLastCalledWith(
      "/tmp/episode",
      { kind: "roll", left_clip_id: "L", right_clip_id: "R" },
      [
        {
          id: "L",
          source_start: 0,
          source_end: 4,
          timeline_start: 0,
          source_id: L.source_id,
        },
        {
          id: "R",
          source_start: 4,
          source_end: 10,
          timeline_start: 4,
          source_id: R.source_id,
        },
      ],
    );
    expect(api.rollClipJoin).toHaveBeenCalledWith(
      "/tmp/episode",
      "L",
      "R",
      0.1,
      "ctx-token",
    );
  });

  it("does not save a roll when its partners change during boundary loading", async () => {
    let release!: () => void;
    vi.mocked(api.loadBoundaryContext).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ token: "ctx-token" } as never);
        }),
    );
    const say = vi.fn();
    const pending = commitSeamRoll("eb:L:R", 100, say);
    const project = useDawStore.getState().project!;
    useDawStore.getState().setProject({
      ...project,
      clips: {
        tracks: {
          [TRACK]: [L, { ...R, source_end: 11, timeline_end: 11 }],
        },
        clip_count: 2,
      },
    });
    release();
    await pending;
    expect(api.rollClipJoin).not.toHaveBeenCalled();
    expect(say).toHaveBeenLastCalledWith(
      "Could not roll the seam. The seam moved before the roll saved. Nothing changed.",
    );
  });
});
