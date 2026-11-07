import { beforeEach, describe, expect, it, vi } from "vitest";
import { activateDocumentScope } from "../document/authorityState";
import { useDawStore } from "../state/dawStore";
import { selectedClipIdsOf, tracksSelection } from "../state/selection";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";

vi.mock("../services/commandQueue", () => ({
  submitQueuedDocumentCommand: vi.fn(),
}));

import { submitQueuedDocumentCommand } from "../services/commandQueue";

const tracks = [
  sampleTrack({ id: "host", label: "Avery" }),
  sampleTrack({ id: "guest", label: "Blair" }),
];

function whole(id: string, trackId: string) {
  return clipRow({ id, track_id: trackId, timeline_end: 20 });
}

function leftPiece(id: string, trackId: string) {
  return clipRow({ id, track_id: trackId, timeline_end: 10 });
}

function rightPiece(id: string, trackId: string) {
  return clipRow({
    id,
    track_id: trackId,
    timeline_start: 10,
    timeline_end: 20,
    source_start: 10,
    source_end: 20,
  });
}

function projectOf(rows: Record<string, ReturnType<typeof clipRow>[]>) {
  return minimalProject({
    tracks,
    clips: {
      tracks: rows,
      clip_count: Object.values(rows).flat().length,
    },
  });
}

const before = projectOf({
  host: [whole("c1", "host")],
  guest: [whole("g1", "guest")],
});
const afterBoth = projectOf({
  host: [leftPiece("c1", "host"), rightPiece("c2", "host")],
  guest: [leftPiece("g1", "guest"), rightPiece("g2", "guest")],
});
const afterHostOnly = projectOf({
  host: [leftPiece("c1", "host"), rightPiece("c2", "host")],
  guest: [rightPiece("g1", "guest")],
});
const beforeSkipped = projectOf({
  host: [whole("c1", "host")],
  guest: [rightPiece("g1", "guest")],
});

function reply(result: Record<string, unknown>, withHead = true) {
  return {
    ...(withHead ? { history_head_id: "h-split" } : {}),
    split_outcome: { kind: "split", times: result.split_times ?? [10] },
    command: { payload: { result } },
  };
}

function guestProposal() {
  return {
    history_head_id: "h-split",
    split_outcome: { kind: "suggested", times: [10] },
    command: { type: "SplitAtTime" },
  };
}

const toast = () => useDawStore.getState().feedbackToast;
const selected = () => selectedClipIdsOf(useDawStore.getState().selection);
const splitHere = () =>
  execute("edit.bladeCut", { atTime: 10 }, { skipWhen: true });

function serverSplits(
  after: ReturnType<typeof projectOf>,
  result: Record<string, unknown> = {},
) {
  vi.mocked(submitQueuedDocumentCommand).mockImplementation(async () => {
    useDawStore.setState({ project: after });
    return reply({ operation: "split_clips_at", ...result });
  });
}

describe("Split reply handling", () => {
  beforeEach(() => {
    activateDocumentScope("/tmp/ep");
    clearRegisteredCommands();
    registerDawCommands();
    vi.mocked(submitQueuedDocumentCommand).mockReset();
    useDawStore.setState({
      projectPath: "/tmp/ep",
      guestMode: null,
      shareCapabilities: null,
      project: before,
      selection: tracksSelection(["host"]),
      shellBreakpoint: "desktop",
      feedbackToast: null,
    });
  });

  it("selects the right-hand piece after Split", async () => {
    serverSplits(afterHostOnly, { affected_tracks: ["host"] });
    await splitHere();
    expect(selected()).toEqual(["c2"]);
  });

  it("selects the right-hand piece on every split track, the first track's piece primary", async () => {
    useDawStore.setState({ selection: tracksSelection(["host", "guest"]) });
    serverSplits(afterBoth, { affected_tracks: ["host", "guest"] });
    await splitHere();
    expect(selected()).toEqual(["c2", "g2"]);
    expect(useDawStore.getState().selection).toMatchObject({
      kind: "clip",
      id: "c2",
      trackId: "host",
    });
  });

  it("does not select an old clip that already started at the split time on a skipped track", async () => {
    useDawStore.setState({
      project: beforeSkipped,
      selection: tracksSelection(["host", "guest"]),
    });
    serverSplits(afterHostOnly, {
      affected_tracks: ["host"],
      skipped_track_ids: ["guest"],
    });
    await splitHere();
    expect(selected()).toEqual(["c2"]);
  });

  it("leaves a selection the user changed while the request ran", async () => {
    const reselected = tracksSelection(["guest"]);
    vi.mocked(submitQueuedDocumentCommand).mockImplementation(async () => {
      useDawStore.setState({ project: afterHostOnly, selection: reselected });
      return reply({ operation: "split_clips_at" });
    });
    await splitHere();
    expect(useDawStore.getState().selection).toBe(reselected);
  });

  it("names only the times the server split when one range edge had no clip", async () => {
    serverSplits(afterHostOnly, { split_times: [10] });
    await execute(
      "edit.bladeCut",
      { atTime: 10, extraAtTimes: [30] },
      { skipWhen: true },
    );
    expect(toast()?.message).toBe("Split at 00:10.000");
    expect(toast()?.undo).toBe("h-split");
  });

  it("uses the applied times from a sanitized Editor reply", async () => {
    vi.mocked(submitQueuedDocumentCommand).mockImplementation(async () => {
      useDawStore.setState({ project: afterHostOnly });
      return {
        history_head_id: "h-split",
        split_outcome: { kind: "split", times: [10] },
        command: { type: "SplitAtTime" },
      };
    });
    await execute(
      "edit.bladeCut",
      { atTime: 30, extraAtTimes: [10] },
      { skipWhen: true },
    );
    expect(toast()?.message).toBe("Split at 00:10.000");
    expect(toast()?.undo).toBe("h-split");
    expect(selected()).toEqual(["c2"]);
  });

  it("does not report a queued acknowledgement as a completed split", async () => {
    vi.mocked(submitQueuedDocumentCommand).mockResolvedValue({
      ok: true,
      queued: true,
      command_id: "queued-split",
      client_seq: 1,
    });
    const held = useDawStore.getState().selection;
    expect(await splitHere()).toEqual({ status: "ok" });
    expect(toast()).toBeNull();
    expect(useDawStore.getState().selection).toBe(held);
  });

  it.each([
    ["missing", undefined],
    ["empty times", { kind: "split", times: [] }],
    [
      "non-finite time",
      { kind: "split", times: [10, Number.POSITIVE_INFINITY] },
    ],
    ["negative time", { kind: "split", times: [10, -1] }],
    ["non-numeric time", { kind: "split", times: [10, "11"] }],
    ["unknown kind", { kind: "other", times: [10] }],
  ])(
    "does not invent completion for %s result facts",
    async (_name, outcome) => {
      vi.mocked(submitQueuedDocumentCommand).mockResolvedValue({
        ok: true,
        idempotent: true,
        command: { type: "SplitAtTime" },
        history_head_id: "h-split",
        split_outcome: outcome,
      });
      const held = useDawStore.getState().selection;
      expect(await splitHere()).toEqual({ status: "ok" });
      expect(toast()?.message).toBe(
        "Split result unavailable. Check the timeline.",
      );
      expect(toast()?.undo ?? null).toBeNull();
      expect(useDawStore.getState().selection).toBe(held);
    },
  );

  it("says suggested when the server only proposed the split", async () => {
    vi.mocked(submitQueuedDocumentCommand).mockResolvedValue(guestProposal());
    await splitHere();
    expect(toast()?.message).toBe("Suggested split at 00:10.000");
  });

  it("offers no Undo for a proposal even though the guest reply carries a history head", async () => {
    vi.mocked(submitQueuedDocumentCommand).mockResolvedValue(guestProposal());
    await splitHere();
    expect(toast()?.undo ?? null).toBeNull();
  });

  it("leaves the selection as it was when the split was only suggested", async () => {
    vi.mocked(submitQueuedDocumentCommand).mockResolvedValue(guestProposal());
    await splitHere();
    expect(useDawStore.getState().selection).toEqual(tracksSelection(["host"]));
  });

  it("leaves the selection when the document changed during the request", async () => {
    vi.mocked(submitQueuedDocumentCommand).mockImplementation(async () => {
      useDawStore.setState({ project: afterHostOnly });
      activateDocumentScope("/tmp/other");
      return reply({ operation: "split_clips_at" });
    });
    const held = useDawStore.getState().selection;
    await splitHere();
    expect(useDawStore.getState().selection).toBe(held);
    expect(toast()).toBeNull();
  });

  it("selects only the piece cut at the split time, not a new clip just after it", async () => {
    const nearby = clipRow({
      id: "c3",
      track_id: "host",
      timeline_start: 10.5,
      timeline_end: 12,
    });
    serverSplits(
      projectOf({
        host: [leftPiece("c1", "host"), rightPiece("c2", "host"), nearby],
        guest: [whole("g1", "guest")],
      }),
    );
    await splitHere();
    expect(selected()).toEqual(["c2"]);
  });

  it("selects the piece at the first edge of a two-edge range split", async () => {
    const wide = projectOf({
      host: [clipRow({ id: "c1", track_id: "host", timeline_end: 40 })],
      guest: [whole("g1", "guest")],
    });
    useDawStore.setState({ project: wide });
    serverSplits(
      projectOf({
        host: [
          clipRow({ id: "c1", track_id: "host", timeline_end: 10 }),
          clipRow({
            id: "c2",
            track_id: "host",
            timeline_start: 10,
            timeline_end: 30,
          }),
          clipRow({
            id: "c3",
            track_id: "host",
            timeline_start: 30,
            timeline_end: 40,
          }),
        ],
        guest: [whole("g1", "guest")],
      }),
      { split_times: [10, 30] },
    );
    await execute(
      "edit.bladeCut",
      { atTime: 10, extraAtTimes: [30] },
      { skipWhen: true },
    );
    expect(selected()).toEqual(["c2"]);
  });
});
