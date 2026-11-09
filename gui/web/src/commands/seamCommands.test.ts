import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { seamById } from "../edit/seam";
import { shareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { trackEditSave } from "../state/documentSendOrder";
import {
  appliedEditRecord,
  clipRow,
  editBoundaries,
  minimalProject,
  sampleTrack,
} from "../test/fixtures";
import type { AppliedEditRecord, ClipRow } from "../types/project";
import { ApiError } from "../utils/apiError";
import {
  hearAcross,
  ROLL_CONFLICT_MESSAGE,
  restoreSeam,
  rollSeam,
  setSeamJoin,
} from "./seamCommands";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  setClipJoin: vi.fn(async () => undefined),
  restoreAppliedEdit: vi.fn(async () => undefined),
  loadBoundaryContext: vi.fn(async () => ({ token: "ctx-token" })),
  rollClipJoin: vi.fn(async () => ({ queued: false })),
}));

vi.mock("../state/documentSendOrder", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../state/documentSendOrder")>();
  return { ...original, trackEditSave: vi.fn(original.trackEditSave) };
});

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
  vi.mocked(api.loadBoundaryContext).mockClear();
  vi.mocked(api.rollClipJoin).mockClear();
  vi.mocked(trackEditSave).mockClear();
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

  it("refuses a crossfade the join cannot blend", async () => {
    const seam = load({ ...R, join_crossfade_blocked: "no_headroom" });
    expect(await setSeamJoin(seam, "crossfade", 80)).toEqual({
      status: "skipped",
    });
    expect(api.setClipJoin).not.toHaveBeenCalled();
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

describe("rollSeam", () => {
  it("sends the delta with the context token and the snapshot geometry", async () => {
    const seam = load();
    expect(await rollSeam(seam, 12.3)).toEqual({ status: "done" });
    expect(api.loadBoundaryContext).toHaveBeenCalledWith(
      PATH,
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
          source_start: 6.4,
          source_end: 10,
          timeline_start: 4,
          source_id: R.source_id,
        },
      ],
    );
    expect(api.rollClipJoin).toHaveBeenCalledTimes(1);
    const [path, left, right, deltaSec, token] =
      vi.mocked(api.rollClipJoin).mock.calls[0] ?? [];
    expect([path, left, right, token]).toEqual([PATH, "L", "R", "ctx-token"]);
    expect(deltaSec).toBeCloseTo(0.0123, 9);
    expect(trackEditSave).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "a guest without edit",
      () => {
        const seam = load();
        useDawStore.setState({
          projectPath: shareProjectKey("tok"),
          shareCapabilities: [],
        });
        return { seam, deltaMs: 5 };
      },
    ],
    [
      "a roll already in flight",
      () => {
        const seam = load();
        useDawStore.setState({ joinMutationInFlight: true });
        return { seam, deltaMs: 5 };
      },
    ],
    [
      "a gap seam",
      () => {
        const seam = load({ ...R, timeline_start: 5, timeline_end: 8.6 });
        return { seam, deltaMs: 5 };
      },
    ],
    ["a delta under 0.05 ms", () => ({ seam: load(), deltaMs: 0.04 })],
  ])("skips %s without a request", async (_name, arrange) => {
    const { seam, deltaMs } = arrange();
    expect(await rollSeam(seam, deltaMs)).toEqual({ status: "skipped" });
    expect(api.loadBoundaryContext).not.toHaveBeenCalled();
    expect(api.rollClipJoin).not.toHaveBeenCalled();
  });

  it("skips a roll the server queued", async () => {
    const seam = load();
    vi.mocked(api.rollClipJoin).mockResolvedValueOnce({ queued: true });
    expect(await rollSeam(seam, 5)).toEqual({ status: "skipped" });
  });

  it("fails when the project changed during the context load", async () => {
    const seam = load();
    vi.mocked(api.loadBoundaryContext).mockImplementationOnce(async () => {
      useDawStore.setState({
        projectEpoch: useDawStore.getState().projectEpoch + 1,
      });
      return { token: "ctx-token" } as Awaited<
        ReturnType<typeof api.loadBoundaryContext>
      >;
    });
    expect(await rollSeam(seam, 5)).toEqual({
      status: "failed",
      message: "The project changed during the roll",
    });
    expect(api.rollClipJoin).not.toHaveBeenCalled();
  });

  it.each([
    ["context", () => vi.mocked(api.loadBoundaryContext)],
    ["roll", () => vi.mocked(api.rollClipJoin)],
  ])(
    "maps a %s 409 document_conflict to the conflict message",
    async (_n, mock) => {
      const seam = load();
      mock().mockRejectedValueOnce(
        new ApiError("boundary preview is stale", "document_conflict", 409),
      );
      expect(await rollSeam(seam, 5)).toEqual({
        status: "failed",
        message: "The seam moved before the roll saved. Nothing changed.",
      });
      expect(ROLL_CONFLICT_MESSAGE).toBe(
        "The seam moved before the roll saved. Nothing changed.",
      );
    },
  );

  it("holds the in-flight flag during the save and clears it on done and on failed", async () => {
    const seam = load();
    let release: () => void = () => undefined;
    vi.mocked(api.rollClipJoin).mockImplementationOnce(
      () =>
        new Promise<{ queued: boolean }>((resolve) => {
          release = () => resolve({ queued: false });
        }),
    );
    const pending = rollSeam(seam, 5);
    await vi.waitFor(() =>
      expect(useDawStore.getState().joinMutationInFlight).toBe(true),
    );
    release();
    expect(await pending).toEqual({ status: "done" });
    expect(useDawStore.getState().joinMutationInFlight).toBe(false);

    vi.mocked(api.rollClipJoin).mockRejectedValueOnce(new Error("disk full"));
    expect(await rollSeam(seam, 5)).toEqual({
      status: "failed",
      message: "disk full",
    });
    expect(useDawStore.getState().joinMutationInFlight).toBe(false);
  });

  it("never announces a failure itself", async () => {
    const seam = load();
    vi.mocked(api.rollClipJoin).mockRejectedValueOnce(new Error("disk full"));
    await rollSeam(seam, 5);
    expect(useDawStore.getState().statusAnnouncement).toBe("");
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

  it.each([
    ["no capabilities", null],
    ["comment only", ["comment"]],
  ])("refuses a share guest with %s and sends nothing", async (_name, caps) => {
    const seam = load(R, [removal("r1", 4, 6.4)]);
    if (seam.kind !== "cut") throw new Error("expected a cut");
    useDawStore.setState({
      projectPath: "share:tok",
      shareCapabilities: caps,
    });
    const result = await restoreSeam(seam);
    expect(result.status).toBe("disabled");
    expect(api.restoreAppliedEdit).not.toHaveBeenCalled();
    expect(useDawStore.getState().selection).not.toBeNull();
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
