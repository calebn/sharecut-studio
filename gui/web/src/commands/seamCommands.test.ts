import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { seamById } from "../edit/seam";
import { useDawStore } from "../state/dawStore";
import {
  appliedEditRecord,
  clipRow,
  editBoundaries,
  minimalProject,
  sampleTrack,
} from "../test/fixtures";
import type { AppliedEditRecord, ClipRow } from "../types/project";
import { hearAcross, restoreSeam, setSeamJoin } from "./seamCommands";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  setClipJoin: vi.fn(async () => undefined),
  restoreAppliedEdit: vi.fn(async () => undefined),
}));

const playRange = vi.hoisted(() => vi.fn());
vi.mock("../utils/playRange", () => ({ playTimelineRange: playRange }));

const TRACK = "mira-voice";
const PATH = "/tmp/episode";

const L = clipRow({
  id: "L",
  source_start: 0,
  source_end: 4,
  timeline_start: 0,
  timeline_end: 4,
  fade_out_ms: 0,
});
const R = clipRow({
  id: "R",
  source_start: 6.4,
  source_end: 10,
  timeline_start: 4,
  timeline_end: 7.6,
  fade_in_ms: 0,
});

function removal(id: string, from: number, to: number): AppliedEditRecord {
  return appliedEditRecord({
    id,
    operation: "ripple_delete",
    source_start: from,
    source_end: to,
    timeline_start: from,
    timeline_end: to,
    restore: { state: "ready" },
  });
}

function load(right: ClipRow = R, records: AppliedEditRecord[] = []) {
  const lane = [L, right];
  useDawStore.setState({
    project: minimalProject({
      tracks: [sampleTrack({ id: TRACK })],
      clips: { tracks: { [TRACK]: lane }, clip_count: 2 },
      edit_boundaries: editBoundaries(lane),
      applied_edits: { count: records.length, records },
    }),
    projectPath: PATH,
    guestMode: null,
    shareCapabilities: null,
    joinMutationInFlight: false,
    selection: { kind: "track", trackId: TRACK },
    statusAnnouncement: "",
    playheadSec: 0,
  });
  const project = useDawStore.getState().project;
  if (!project) throw new Error("no project");
  const seam = seamById(project, "eb:L:R");
  if (!seam) throw new Error("no seam");
  return seam;
}

beforeEach(() => {
  vi.mocked(api.setClipJoin).mockClear();
  vi.mocked(api.restoreAppliedEdit).mockClear();
  playRange.mockClear();
});

describe("setSeamJoin", () => {
  it("sends the mode and length once", async () => {
    const seam = load({ ...R, join_in_mode: "crossfade", fade_in_ms: 60 });
    await setSeamJoin(seam, "crossfade", 120);
    expect(api.setClipJoin).toHaveBeenCalledWith(
      PATH,
      "L",
      "R",
      "crossfade",
      120,
    );
  });

  it("sends a 1 ms crossfade when switching from a zero length", async () => {
    const seam = load();
    await setSeamJoin(seam, "crossfade", null);
    expect(api.setClipJoin).toHaveBeenCalledWith(
      PATH,
      "L",
      "R",
      "crossfade",
      1,
    );
  });

  it("sends no length for a hard edge", async () => {
    const seam = load({ ...R, join_in_mode: "fade", fade_in_ms: 40 });
    await setSeamJoin(seam, "cut", null);
    expect(api.setClipJoin).toHaveBeenCalledWith(PATH, "L", "R", "cut", null);
  });

  it("does nothing when the mode and length already hold", async () => {
    const seam = load();
    expect(await setSeamJoin(seam, "fade", null)).toEqual({
      status: "skipped",
    });
    expect(api.setClipJoin).not.toHaveBeenCalled();
  });

  it("ignores a second call while one is in flight", async () => {
    const seam = load();
    let release: () => void = () => undefined;
    vi.mocked(api.setClipJoin).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const first = setSeamJoin(seam, "crossfade", 80);
    expect(await setSeamJoin(seam, "cut", null)).toEqual({ status: "skipped" });
    release();
    await first;
    expect(api.setClipJoin).toHaveBeenCalledTimes(1);
    expect(useDawStore.getState().joinMutationInFlight).toBe(false);
  });

  it("reports a rejected save and says it", async () => {
    const seam = load();
    vi.mocked(api.setClipJoin).mockRejectedValueOnce(
      new Error("No room to blend."),
    );
    expect(await setSeamJoin(seam, "crossfade", 80)).toEqual({
      status: "failed",
      message: "No room to blend.",
    });
    expect(useDawStore.getState().statusAnnouncement).toBe("No room to blend.");
  });
});

describe("restoreSeam", () => {
  it("restores every matched record in one call and clears the selection", async () => {
    const seam = load(R, [removal("r1", 4, 5), removal("r2", 5, 6.4)]);
    if (seam.kind !== "cut") throw new Error("expected a cut");
    expect(await restoreSeam(seam)).toEqual({ status: "ok" });
    expect(api.restoreAppliedEdit).toHaveBeenCalledTimes(1);
    expect(api.restoreAppliedEdit).toHaveBeenCalledWith(PATH, ["r1", "r2"]);
    expect(useDawStore.getState().selection).toBeNull();
    expect(useDawStore.getState().statusAnnouncement).toBe("Restored 2.4 s");
  });

  it("says why Keep is off without calling the server", async () => {
    const seam = load(R, []);
    if (seam.kind !== "cut") throw new Error("expected a cut");
    expect(await restoreSeam(seam)).toEqual({
      status: "disabled",
      reason: "Undo this in History",
    });
    expect(api.restoreAppliedEdit).not.toHaveBeenCalled();
  });
});

describe("hearAcross", () => {
  it("plays two seconds either side of the join", () => {
    const seam = load();
    useDawStore.setState({ playheadSec: 0 });
    hearAcross(seam);
    expect(playRange).toHaveBeenCalledWith(
      expect.objectContaining({ start: 2, end: 6, padSec: 0 }),
    );
  });

  it("starts at zero when the join is near the start", () => {
    const early = clipRow({ id: "L", source_end: 1, timeline_end: 1 });
    useDawStore.setState({
      project: minimalProject({
        tracks: [sampleTrack({ id: TRACK })],
        clips: {
          tracks: { [TRACK]: [early, { ...R, timeline_start: 1 }] },
          clip_count: 2,
        },
        edit_boundaries: editBoundaries([early, { ...R, timeline_start: 1 }]),
      }),
    });
    const project = useDawStore.getState().project;
    if (!project) throw new Error("no project");
    const seam = seamById(project, "eb:L:R");
    if (!seam) throw new Error("no seam");
    hearAcross(seam);
    expect(playRange).toHaveBeenLastCalledWith(
      expect.objectContaining({ start: 0, end: 3 }),
    );
  });
});
