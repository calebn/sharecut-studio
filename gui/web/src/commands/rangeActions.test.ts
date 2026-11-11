import { beforeEach, describe, expect, it, vi } from "vitest";
import { submitDocumentCommand } from "../api/documentEdits";
import { getClipboard, setClipboard } from "../edit/clipboard";
import { makeRangeTarget } from "../edit/rangeSelection";
import { useDawStore } from "../state/dawStore";
import { deferred } from "../test/deferred";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import { SPLIT_MICRO_FADE_MS } from "../types/limits.generated";
import { ApiError } from "../utils/apiError";
import { startBounce } from "./bounceRunnerHandle";
import { clearRegisteredCommands, execute } from "./execute";
import {
  rangeActionDescriptors,
  registerRangeCommands,
  runRangeAction,
} from "./rangeActions";
import { runAndAnnounceRefusal } from "./refusal";

vi.mock("./bounceRunnerHandle", () => ({ startBounce: vi.fn() }));
vi.mock("../api/documentEdits", async (orig) => ({
  ...(await orig<typeof import("../api/documentEdits")>()),
  submitDocumentCommand: vi.fn(),
}));
const p = minimalProject({
  render_status: {
    needs_rerender: false,
    reconciliation: { stale: false },
    premix: { exists: true },
  },
  tracks: [sampleTrack({ id: "a", range_media_seal: "a" })],
  clips: {
    tracks: {
      a: [
        clipRow({
          id: "copy",
          track_id: "a",
          source_id: null,
          source_start: 0,
          source_end: 5,
          timeline_start: 10,
          timeline_end: 15,
        }),
      ],
    },
    clip_count: 1,
  },
});
const target = makeRangeTarget(p, [{ start: 11, end: 12 }], ["a"])!;
beforeEach(() => {
  vi.resetAllMocks();
  clearRegisteredCommands();
  registerRangeCommands();
  setClipboard(null);
  useDawStore.setState({
    project: p,
    projectPath: "/tmp/ep",
    stage: "edit",
    guestMode: null,
    shareCapabilities: null,
    projectEpoch: 1,
    selection: { kind: "range", target },
    rangeBusy: false,
    joinMutationInFlight: false,
    commentDraft: null,
    sourcePreview: null,
  });
});
describe("shared range action policy and commands", () => {
  it("lets a guest play a range while the live project is stale, since they hear the frozen review version", async () => {
    useDawStore.setState({
      project: {
        ...p,
        render_status: { ...p.render_status, needs_rerender: true },
      },
    });
    expect(
      rangeActionDescriptors(useDawStore.getState(), target)[0].reason,
    ).toBeNull();
    useDawStore.setState({
      projectPath: "share:token",
      guestMode: "view",
      shareCapabilities: ["view"],
    });
    expect(
      rangeActionDescriptors(useDawStore.getState(), target)[0].reason,
    ).toBeNull();
  });
  it("exposes the same six actions with host labels", () =>
    expect(
      rangeActionDescriptors(useDawStore.getState(), target).map((d) => [
        d.action,
        d.label,
        d.reason,
      ]),
    ).toEqual([
      ["play", "Play", null],
      ["cut", "Cut", null],
      ["mute", "Mute", null],
      ["fillRoomTone", "Fill room tone", "No gap between clips in this range"],
      ["comment", "Comment", null],
      ["bounce", "Export", null],
    ]));
  it.each([
    ["suggest", "Suggest cut", "Suggest mute"],
    ["edit", "Cut", "Mute"],
  ])(
    "a %s guest gets %s / %s and cannot export",
    (mode, cutLabel, muteLabel) => {
      const fill =
        mode === "edit"
          ? "No gap between clips in this range"
          : "Only editors can fill room tone";
      useDawStore.setState({
        projectPath: "share:token",
        guestMode: mode,
        shareCapabilities: [mode, "view", "comment"],
      });
      expect(
        rangeActionDescriptors(useDawStore.getState(), target).map((d) => [
          d.label,
          d.reason,
        ]),
      ).toEqual([
        ["Play full mix", null],
        [cutLabel, null],
        [muteLabel, null],
        ["Fill room tone", fill],
        ["Comment", null],
        ["Export", "Only the host can export selected tracks"],
      ]);
    },
  );
  it("lets a suggest-only commenter on Review propose a cut from the palette gate", async () => {
    useDawStore.setState({
      projectPath: "share:token",
      guestMode: "comment",
      shareCapabilities: [
        "play",
        "view",
        "comment",
        "reply",
        "action",
        "suggest",
      ],
      stage: "review",
    });
    vi.mocked(submitDocumentCommand).mockResolvedValue({ type: "Applied" });
    expect(await execute("range.cut")).toEqual({ status: "ok" });
    expect(submitDocumentCommand).toHaveBeenCalledTimes(1);
    expect(vi.mocked(submitDocumentCommand).mock.calls[0][1]).toBe(
      "EditSelectedRange",
    );
  });
  it("keeps fillRoomTone disabled for a suggest-only commenter on Review", async () => {
    useDawStore.setState({
      projectPath: "share:token",
      guestMode: "comment",
      shareCapabilities: [
        "play",
        "view",
        "comment",
        "reply",
        "action",
        "suggest",
      ],
      stage: "review",
    });
    expect((await execute("range.fillRoomTone")).status).toBe("disabled");
    expect(submitDocumentCommand).not.toHaveBeenCalled();
  });
  it.each(["cut", "mute"] as const)(
    "dispatches one sealed %s command",
    async (action) => {
      vi.mocked(submitDocumentCommand).mockResolvedValue({ type: "Applied" });
      expect(await execute(`range.${action}`, {}, { skipWhen: true })).toEqual({
        status: "ok",
      });
      expect(submitDocumentCommand).toHaveBeenCalledExactlyOnceWith(
        "/tmp/ep",
        "EditSelectedRange",
        { action, targets: [target] },
      );
      expect(useDawStore.getState().selection).toBeNull();
      if (action === "cut")
        expect(getClipboard()?.extracts).toEqual([
          {
            track_id: "a",
            source_start: 1,
            source_end: 2,
            relative_timeline_start: 0,
            source_id: null,
            fade_in_ms: SPLIT_MICRO_FADE_MS,
            fade_out_ms: SPLIT_MICRO_FADE_MS,
            join_in_mode: "fade",
            mute_regions: [],
          },
        ]);
    },
  );
  it("gives a cut's new edges only the micro fade, never the clip's far-edge fades", async () => {
    const faded = {
      ...p,
      clips: {
        ...p.clips!,
        tracks: {
          a: [
            {
              ...p.clips!.tracks.a![0]!,
              fade_in_ms: 400,
              fade_out_ms: 300,
              fade_in_curve: "s" as const,
              fade_out_curve: "equal_power" as const,
              join_in_mode: "cut" as const,
            },
          ],
        },
      },
    };
    const fadedTarget = makeRangeTarget(
      faded,
      [{ start: 11, end: 12 }],
      ["a"],
    )!;
    useDawStore.setState({
      project: faded,
      selection: { kind: "range", target: fadedTarget },
    });
    vi.mocked(submitDocumentCommand).mockResolvedValue({ type: "Applied" });
    expect(await execute("range.cut", {}, { skipWhen: true })).toEqual({
      status: "ok",
    });
    const [extract] = getClipboard()?.extracts ?? [];
    expect(extract).toMatchObject({
      fade_in_ms: SPLIT_MICRO_FADE_MS,
      fade_out_ms: SPLIT_MICRO_FADE_MS,
      join_in_mode: "fade",
    });
    expect(extract).not.toHaveProperty("fade_in_curve");
    expect(extract).not.toHaveProperty("fade_out_curve");
  });
  it("preserves selection and clipboard when queued", async () => {
    vi.mocked(submitDocumentCommand).mockResolvedValue({
      ok: true,
      queued: true,
    });
    await runRangeAction("cut");
    expect(useDawStore.getState().selection).toEqual({ kind: "range", target });
    expect(getClipboard()).toBeNull();
    expect(useDawStore.getState().rangeBusy).toBe(false);
  });
  it("prevents a duplicate while a command is running and permits retry after failure", async () => {
    let reject!: (e: Error) => void;
    vi.mocked(submitDocumentCommand).mockReturnValue(
      new Promise((_r, j) => {
        reject = j;
      }),
    );
    const first = runRangeAction("mute");
    expect(await runRangeAction("mute")).toEqual({
      status: "disabled",
      reason: "Range action in progress",
    });
    reject(new Error("Select the range again"));
    expect(await first).toEqual({
      status: "disabled",
      reason: "Select the range again",
      told: true,
    });
    expect(useDawStore.getState().selection).toEqual({ kind: "range", target });
    expect(useDawStore.getState().rangeBusy).toBe(false);
  });
  it("rechecks current geometry at activation", async () => {
    useDawStore.setState({
      project: { ...p, clips: { tracks: { a: [] }, clip_count: 0 } },
    });
    expect(await runRangeAction("cut")).toEqual({
      status: "disabled",
      reason: "Selected audio changed. Select the range again.",
    });
    expect(submitDocumentCommand).not.toHaveBeenCalled();
  });
  it("opens a comment draft with exact intervals and lanes", async () => {
    expect(await runRangeAction("comment")).toEqual({ status: "ok" });
    expect(useDawStore.getState().commentDraft).toEqual({
      startSec: 11,
      endSec: 12,
      trackIds: ["a"],
      intervals: [{ start: 11, end: 12 }],
    });
    expect(useDawStore.getState().stage).toBe("review");
    expect(useDawStore.getState().reviewSection).toBe("queue");
  });
  it("exports the range in place through the runner, keeping the stage", async () => {
    vi.mocked(startBounce).mockResolvedValue({ status: "ok" });
    expect(await runRangeAction("bounce")).toEqual({ status: "ok" });
    expect(startBounce).toHaveBeenCalledWith({
      range: target,
      trackIds: ["a"],
      source: "mix",
      includeMp3: false,
    });
    expect(useDawStore.getState().stage).toBe("edit");
  });
  it("plays a prepared range through the owned transport preview", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Blob(["audio"]), { status: 200 })),
    );
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:range"),
      revokeObjectURL: vi.fn(),
    });
    expect(await runRangeAction("play")).toEqual({ status: "ok" });
    expect(useDawStore.getState().sourcePreview).toMatchObject({
      ownerId: "selected-range",
      media: { kind: "rendered", url: "blob:range" },
      startSec: 0,
      endSec: 1,
    });
    vi.unstubAllGlobals();
  });

  it("marks a current-epoch range playback failure as already announced", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("range transport failed");
      }),
    );
    const announced = vi.spyOn(useDawStore.getState(), "announceStatus");
    const result = await runAndAnnounceRefusal(() => execute("range.play"));
    expect(result).toEqual({
      status: "disabled",
      reason: "range transport failed",
      told: true,
    });
    expect(announced).toHaveBeenCalledTimes(1);
    expect(announced).toHaveBeenCalledWith("range transport failed", {
      tone: "error",
    });
    vi.unstubAllGlobals();
  });

  it("marks a current-epoch selection change as already announced", async () => {
    const response = deferred<Response>();
    const fetch = vi.fn(() => response.promise);
    vi.stubGlobal("fetch", fetch);
    const announced = vi.spyOn(useDawStore.getState(), "announceStatus");
    const pending = runAndAnnounceRefusal(() => execute("range.play"));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    useDawStore.setState({ selection: null });
    response.resolve(new Response(new Blob(["audio"]), { status: 200 }));
    expect(await pending).toEqual({
      status: "disabled",
      reason: "Selection changed while audio was prepared",
      told: true,
    });
    expect(announced).toHaveBeenCalledTimes(1);
    expect(announced).toHaveBeenCalledWith(
      "Selection changed while audio was prepared",
      { tone: "error" },
    );
    vi.unstubAllGlobals();
  });

  it("does not claim acknowledgement for stale-epoch playback", async () => {
    const response = deferred<Response>();
    const fetch = vi.fn(() => response.promise);
    vi.stubGlobal("fetch", fetch);
    const announced = vi.spyOn(useDawStore.getState(), "announceStatus");
    const pending = execute("range.play");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    useDawStore.setState({ projectEpoch: 2 });
    response.resolve(new Response(new Blob(["audio"]), { status: 200 }));
    expect(await pending).toEqual({
      status: "disabled",
      reason: "Selection changed while audio was prepared",
    });
    expect(announced).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("does not claim acknowledgement for stale-epoch transport errors", async () => {
    const response = deferred<Response>();
    const fetch = vi.fn(() => response.promise);
    vi.stubGlobal("fetch", fetch);
    const announced = vi.spyOn(useDawStore.getState(), "announceStatus");
    const pending = execute("range.play");
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    useDawStore.setState({ projectEpoch: 2 });
    response.reject(new Error("stale range transport failed"));
    expect(await pending).toEqual({
      status: "disabled",
      reason: "stale range transport failed",
    });
    expect(announced).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("fill range with room tone", () => {
  const gapProject = minimalProject({
    ...p,
    tracks: [sampleTrack({ id: "a", range_media_seal: "a" })],
    clips: {
      tracks: {
        a: [
          clipRow({
            id: "left",
            track_id: "a",
            source_id: null,
            source_start: 0,
            source_end: 5,
            timeline_start: 0,
            timeline_end: 5,
          }),
          clipRow({
            id: "right",
            track_id: "a",
            source_id: null,
            source_start: 5,
            source_end: 10,
            timeline_start: 8,
            timeline_end: 13,
          }),
        ],
      },
      clip_count: 2,
    },
  });
  const gapTarget = makeRangeTarget(gapProject, [{ start: 4, end: 9 }], ["a"])!;
  const reasonOf = (
    state: Parameters<typeof rangeActionDescriptors>[0],
    t = gapTarget,
  ) =>
    rangeActionDescriptors(state, t).find((d) => d.action === "fillRoomTone")
      ?.reason;

  beforeEach(() => {
    useDawStore.setState({
      project: gapProject,
      selection: { kind: "range", target: gapTarget },
    });
  });

  it("is offered only where a gap sits between clips", () => {
    expect(reasonOf(useDawStore.getState())).toBeNull();
    const clipOnly = makeRangeTarget(
      gapProject,
      [{ start: 1, end: 2 }],
      ["a"],
    )!;
    expect(reasonOf(useDawStore.getState(), clipOnly)).toBe(
      "No gap between clips in this range",
    );
  });

  it("is refused for a share that cannot apply edits", () => {
    useDawStore.setState({
      projectPath: "share:abc",
      shareCapabilities: ["suggest"],
    });
    expect(reasonOf(useDawStore.getState())).toBe(
      "Only editors can fill room tone",
    );
  });

  it("sends FillRoomTone for the range and tells the user what it filled", async () => {
    vi.mocked(submitDocumentCommand).mockResolvedValue({ type: "Applied" });
    expect(await execute("range.fillRoomTone")).toEqual({ status: "ok" });
    expect(submitDocumentCommand).toHaveBeenCalledWith(
      "/tmp/ep",
      "FillRoomTone",
      { track_id: "a", start_sec: 4, end_sec: 9 },
    );
    expect(useDawStore.getState().statusAnnouncement).toContain(
      "Filled room tone in 1 place",
    );
    expect(useDawStore.getState().selection).toBeNull();
  });

  it("explains a refusal in plain words", async () => {
    vi.mocked(submitDocumentCommand).mockRejectedValue(
      new ApiError(
        "no room tone available (digital_silence)",
        "no_source",
        400,
      ),
    );
    const announced = vi.spyOn(useDawStore.getState(), "announceStatus");
    const result = await runAndAnnounceRefusal(() =>
      execute("range.fillRoomTone"),
    );
    expect(result).toEqual({
      status: "disabled",
      reason: "No usable room tone on this track to fill with",
      told: true,
    });
    expect(announced).toHaveBeenCalledTimes(1);
    expect(announced).toHaveBeenCalledWith(
      "No usable room tone on this track to fill with",
      { tone: "error" },
    );
  });

  it("sends one command per interval that has a gap and names a stop", async () => {
    const twoIntervals = makeRangeTarget(
      gapProject,
      [
        { start: 4, end: 9 },
        { start: 11, end: 12 },
      ],
      ["a"],
    )!;
    useDawStore.setState({
      selection: { kind: "range", target: twoIntervals },
    });
    vi.mocked(submitDocumentCommand).mockResolvedValue({ type: "Applied" });
    await execute("range.fillRoomTone");
    expect(submitDocumentCommand).toHaveBeenCalledTimes(1);
    useDawStore.setState({
      selection: { kind: "range", target: twoIntervals },
    });
    vi.mocked(submitDocumentCommand).mockRejectedValue(new Error("offline"));
    expect(await execute("range.fillRoomTone")).toEqual({
      status: "disabled",
      reason: "offline",
      told: true,
    });
  });
});

describe("range.arm", () => {
  beforeEach(() => {
    useDawStore.setState({
      selection: null,
      rangeArmed: false,
      rangeDraft: null,
      playheadSec: 2,
    });
  });
  it("seeds a 5 s draft at the playhead on every track", async () => {
    expect(await execute("range.arm")).toEqual({ status: "ok" });
    expect(useDawStore.getState().rangeArmed).toBe(true);
    expect(useDawStore.getState().rangeDraft).toEqual({
      start: 2,
      end: 7,
      trackIds: ["a"],
    });
  });
  it("disarms and drops the draft when armed again", async () => {
    await execute("range.arm");
    expect(await execute("range.arm")).toEqual({ status: "ok" });
    expect(useDawStore.getState().rangeArmed).toBe(false);
    expect(useDawStore.getState().rangeDraft).toBeNull();
  });
  it("refuses to arm over a committed range and keeps it through close", async () => {
    useDawStore.setState({ selection: { kind: "range", target } });
    expect(await execute("range.arm")).toEqual({
      status: "disabled",
      reason: "A range is already selected",
    });
    expect(useDawStore.getState().rangeArmed).toBe(false);
    expect(useDawStore.getState().selection).toMatchObject({ kind: "range" });
  });
  it("refuses an empty timeline", async () => {
    useDawStore.setState({ project: minimalProject() });
    expect(await execute("range.arm")).toEqual({
      status: "disabled",
      reason: "Nothing to select yet",
    });
    expect(useDawStore.getState().rangeArmed).toBe(false);
  });
  it("refuses while an edit is in flight", async () => {
    useDawStore.setState({ rangeBusy: true });
    expect(await execute("range.arm")).toEqual({
      status: "disabled",
      reason: "Open a project and wait for the current edit",
    });
  });
  it("refuses a range verb over silence with a reason", async () => {
    const silent = makeRangeTarget(p, [{ start: 0, end: 1 }], ["a"])!;
    expect(silent.clips).toEqual([]);
    useDawStore.setState({ selection: { kind: "range", target: silent } });
    const result = await runRangeAction("cut");
    expect(result.status).toBe("disabled");
  });
});
