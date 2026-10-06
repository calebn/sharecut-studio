import { beforeEach, describe, expect, it, vi } from "vitest";
import { submitDocumentCommand } from "../api/documentEdits";
import { getClipboard, setClipboard } from "../edit/clipboard";
import { makeRangeTarget } from "../edit/rangeSelection";
import { useDawStore } from "../state/dawStore";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import { clearRegisteredCommands, execute } from "./execute";
import {
  rangeActionDescriptors,
  registerRangeCommands,
  runRangeAction,
} from "./rangeActions";

vi.mock("../api/documentEdits", () => ({ submitDocumentCommand: vi.fn() }));
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
    guestMode: null,
    shareCapabilities: null,
    projectEpoch: 1,
    selection: { kind: "range", target },
    rangeBusy: false,
    joinMutationInFlight: false,
    bounceDialogOpen: false,
    bounceRangeTarget: null,
    commentDraft: null,
    sourcePreview: null,
  });
});
describe("shared range action policy and commands", () => {
  it("blocks guest playback of an old mix while retaining host live rendering", async () => {
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
    expect(await runRangeAction("play")).toEqual({
      status: "disabled",
      reason:
        "Mix out of date. Ask the host to Refresh before playing this range.",
    });
  });
  it("exposes the same five actions with host labels", () =>
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
      ["comment", "Comment", null],
      ["bounce", "Bounce", null],
    ]));
  it.each([
    ["suggest", "Suggest cut", "Suggest mute"],
    ["edit", "Cut", "Mute"],
  ])(
    "a %s guest gets %s / %s and cannot bounce",
    (mode, cutLabel, muteLabel) => {
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
        ["Comment", null],
        ["Bounce", "Only the host can export selected tracks"],
      ]);
    },
  );
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
        { action, target },
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
            fade_in_ms: 0,
            fade_out_ms: 0,
            join_in_mode: "fade",
            mute_regions: [],
          },
        ]);
    },
  );
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
    expect(useDawStore.getState().activeTab).toBe("comments");
  });
  it("opens Bounce configuration with a detached fixed target", async () => {
    expect(await runRangeAction("bounce")).toEqual({ status: "ok" });
    const state = useDawStore.getState();
    expect(state.bounceRangeTarget).toEqual(target);
    expect(state.bounceRangeTarget).not.toBe(target);
    expect(state.bounceDialogOpen).toBe(true);
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
});
