import { beforeEach, describe, expect, it, vi } from "vitest";
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
    command: { payload: { result } },
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

  it("says suggested, with no Undo, when the server only proposed the split", async () => {
    vi.mocked(submitQueuedDocumentCommand).mockResolvedValue(
      reply({ operation: "propose_split", edits: [{ id: "e1" }] }, false),
    );
    await splitHere();
    expect(toast()?.message).toBe("Suggested split at 00:10.000");
    expect(toast()?.undo ?? null).toBeNull();
  });

  it("offers no Undo for a proposal even when the reply carries a history head", async () => {
    vi.mocked(submitQueuedDocumentCommand).mockResolvedValue(
      reply({ operation: "propose_split", edits: [{ id: "e1" }] }),
    );
    await splitHere();
    expect(toast()?.undo ?? null).toBeNull();
  });

  it("leaves the selection as it was when the split was only suggested", async () => {
    vi.mocked(submitQueuedDocumentCommand).mockResolvedValue(
      reply({ operation: "propose_split", edits: [{ id: "e1" }] }),
    );
    await splitHere();
    expect(useDawStore.getState().selection).toEqual(tracksSelection(["host"]));
  });
});
