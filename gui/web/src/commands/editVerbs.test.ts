import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { useDawStore } from "../state/dawStore";
import {
  EDIT_SELECTIONS,
  editFixtureProject,
  JONAS,
  MIRA,
} from "../test/actionBarFixtures";
import { minimalProject } from "../test/fixtures";
import {
  barModelOf,
  currentEditFacts as factsOf,
  runEditVerb,
  runMute,
  splitPlan,
  WIRED_VERBS,
} from "./editVerbs";
import { clearRegisteredCommands, execute, registerCommand } from "./execute";
import { registerDawCommands } from "./register";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  deleteClips: vi.fn(async () => "h-delete"),
  deleteChapter: vi.fn(async () => undefined),
  setEnvelope: vi.fn(async () => "h-env"),
  approveEdits: vi.fn(),
  rejectEdits: vi.fn(),
  applySuggestedActions: vi.fn(),
  splitAtTime: vi.fn(async () => "h-split"),
}));

const runRangeAction = vi.hoisted(() =>
  vi.fn(async (): Promise<{ status: "ok" }> => ({ status: "ok" })),
);
vi.mock("./rangeActions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rangeActions")>()),
  runRangeAction,
}));

const playRange = vi.hoisted(() => vi.fn());
vi.mock("../utils/playRange", () => ({ playTimelineRange: playRange }));

function host(selection: unknown, extra: Record<string, unknown> = {}) {
  useDawStore.setState({
    project: editFixtureProject(),
    projectPath: "/tmp/episode",
    guestMode: null,
    shareCapabilities: null,
    stage: "edit",
    selection: selection as never,
    inspectorKey: null,
    rangeScopeTrackIds: null,
    rangeBusy: false,
    joinMutationInFlight: false,
    playheadSec: 1,
    statusAnnouncement: "",
    ...extra,
  });
}

const announced = () => useDawStore.getState().statusAnnouncement;

beforeEach(() => {
  vi.clearAllMocks();
  clearRegisteredCommands();
  registerDawCommands();
});

describe("splitPlan", () => {
  const project = editFixtureProject();
  const facts = (selection: unknown) => {
    host(selection);
    return factsOf()!;
  };

  it("cuts a range or words at both edges, on the tracks it covers", () => {
    const f = facts(EDIT_SELECTIONS.rangeOnAllTracks);
    expect(splitPlan(f, EDIT_SELECTIONS.rangeOnAllTracks, project, 9)).toEqual({
      atTime: 1,
      extraAtTimes: [2],
      trackIds: [MIRA, JONAS],
    });
  });

  it("uses the tracks the selection covers, whatever unconfirmed ticks say", () => {
    useDawStore.setState({ rangeScopeTrackIds: [MIRA] });
    const f = facts(EDIT_SELECTIONS.rangeOnAllTracks);
    expect(
      splitPlan(f, EDIT_SELECTIONS.rangeOnAllTracks, project, 9),
    ).toMatchObject({ trackIds: [MIRA, JONAS] });
  });

  it("splits a clip at the playhead only when it is inside the clip", () => {
    const f = facts(EDIT_SELECTIONS.clip);
    expect(splitPlan(f, EDIT_SELECTIONS.clip, project, 2)).toEqual({
      atTime: 2,
      extraAtTimes: [],
      trackIds: [MIRA],
    });
    expect(splitPlan(f, EDIT_SELECTIONS.clip, project, 8)).toBe(
      "Move the playhead onto the clip to split it",
    );
  });

  it("splits at the playhead with nothing selected", () => {
    const f = facts(null);
    expect(splitPlan(f, null, project, 5)).toEqual({
      atTime: 5,
      extraAtTimes: [],
    });
  });
});

describe("Split", () => {
  it("cuts both edges of a range in one call, so one Undo restores both", async () => {
    host(EDIT_SELECTIONS.rangeOnAllTracks);
    await runEditVerb("split", factsOf()!);
    expect(api.splitAtTime).toHaveBeenCalledTimes(1);
    expect(api.splitAtTime).toHaveBeenCalledWith(
      "/tmp/episode",
      1,
      [MIRA, JONAS],
      null,
      [2],
    );
    expect(announced()).toBe("Split at 00:01.000 and 00:02.000");
  });

  it("says why nothing was split instead of staying silent", async () => {
    host(EDIT_SELECTIONS.clip, { playheadSec: 9 });
    const result = await runEditVerb("split", factsOf()!);
    expect(result.status).toBe("disabled");
    expect(announced()).toBe("Move the playhead onto the clip to split it");
    expect(api.splitAtTime).not.toHaveBeenCalled();
  });

  it("is the S key's command too", async () => {
    host(null, { playheadSec: 3 });
    await execute("edit.split");
    expect(api.splitAtTime).toHaveBeenCalledWith(
      "/tmp/episode",
      3,
      [MIRA, JONAS],
      null,
      [],
    );
  });
});

describe("Cut, and the Backspace order", () => {
  it("deletes the selected clips and leaves a gap", async () => {
    host(EDIT_SELECTIONS.clips);
    await execute("edit.delete");
    expect(api.deleteClips).toHaveBeenCalledWith("/tmp/episode", [
      "a",
      "b",
      "c",
    ]);
    expect(announced()).toBe("Deleted 3 clips");
  });

  it("cuts words and ranges through the range cut", async () => {
    host(EDIT_SELECTIONS.liveWords);
    await execute("edit.delete");
    host(EDIT_SELECTIONS.rangeOnAllTracks);
    await execute("edit.delete");
    expect(runRangeAction).toHaveBeenCalledTimes(2);
    expect(runRangeAction).toHaveBeenCalledWith("cut");
  });

  it("accepts a suggestion's own verb: a cut approves, a shorten applies the suggestion", async () => {
    host(EDIT_SELECTIONS.suggestion);
    vi.mocked(api.approveEdits).mockResolvedValue({
      history_head_id: "h",
    } as never);
    await execute("edit.delete");
    expect(api.approveEdits).toHaveBeenCalled();
    const project = editFixtureProject();
    project.pending_edits[0] = {
      ...project.pending_edits[0]!,
      suggested_action: "shorten",
    };
    host(EDIT_SELECTIONS.suggestion, { project });
    vi.mocked(api.applySuggestedActions).mockResolvedValue({
      historyHead: "h2",
      summary: "Shortened the pause",
    } as never);
    await execute("edit.delete");
    expect(api.applySuggestedActions).toHaveBeenCalledWith("/tmp/episode", [
      "pending-cut",
    ]);
  });

  it("removes a chapter for the host and refuses a guest", async () => {
    host({ kind: "chapter", id: "Intro", time: 4 });
    await execute("edit.delete");
    expect(api.deleteChapter).toHaveBeenCalledWith("/tmp/episode", 4, "Intro");
    expect(useDawStore.getState().selection).toBeNull();
    host(
      { kind: "chapter", id: "Intro", time: 4 },
      { projectPath: "share:tok", guestMode: "edit" },
    );
    vi.mocked(api.deleteChapter).mockClear();
    const result = await execute("edit.delete", {}, { skipWhen: true });
    expect(result).toEqual({
      status: "disabled",
      reason: "Only the host can remove a chapter",
    });
    expect(api.deleteChapter).not.toHaveBeenCalled();
  });

  it("removes an envelope point, with Undo, and keeps the envelope selected", async () => {
    const project = minimalProject({
      tracks: editFixtureProject().tracks,
      envelopes: [
        {
          track_id: MIRA,
          parameter: "volume",
          points: [
            { id: "p1", time: 1, value: 1 },
            { id: "p2", time: 2, value: 0.5 },
          ],
        },
      ],
    });
    host({ kind: "envelopePoint", trackId: MIRA, pointId: "p2" }, { project });
    await execute("edit.delete");
    expect(vi.mocked(api.setEnvelope).mock.calls[0]?.[2]).toEqual([
      { id: "p1", time: 1, value: 1 },
    ]);
    expect(useDawStore.getState().selection).toEqual({
      kind: "envelope",
      trackId: MIRA,
    });
  });

  it("names what it cannot cut", async () => {
    host({ kind: "track", trackId: MIRA });
    expect(await execute("edit.delete")).toEqual({
      status: "disabled",
      reason: "There is nothing to cut in this selection",
    });
    host(null);
    expect(await execute("edit.delete")).toEqual({
      status: "disabled",
      reason: "No clip selected",
    });
  });
});

describe("Keep", () => {
  it("rejects a suggestion", async () => {
    host(EDIT_SELECTIONS.suggestion);
    vi.mocked(api.rejectEdits).mockResolvedValue({
      history_head_id: "h",
    } as never);
    await execute("edit.keep");
    expect(api.rejectEdits).toHaveBeenCalledWith("/tmp/episode", [
      "pending-cut",
    ]);
  });

  it("opens History for a cut, because the server restores a mute but not a removal", async () => {
    const history = vi.fn(() => ({ status: "ok" as const }));
    registerCommand("edit.history", history);
    host(EDIT_SELECTIONS.cutWords);
    await execute("edit.keep");
    expect(history).toHaveBeenCalled();
    expect(announced()).toBe("A cut comes back with Undo. History is open.");
  });

  it("says there is nothing to keep where nothing was cut", async () => {
    host(EDIT_SELECTIONS.liveWords);
    expect(await execute("edit.keep")).toEqual({
      status: "disabled",
      reason: "Nothing was cut here",
    });
  });
});

describe("verbs that call other commands", () => {
  it("refuses a bar that no longer matches the selection", async () => {
    host(EDIT_SELECTIONS.clip);
    const stale = factsOf()!;
    host(EDIT_SELECTIONS.suggestion);
    await runEditVerb("split", stale);
    expect(announced()).toBe("The selection changed. Try again.");
  });

  it("hears a clip from its span and a range through the range play", async () => {
    host(EDIT_SELECTIONS.clip);
    await runEditVerb("hear", factsOf()!);
    expect(playRange).toHaveBeenCalledWith(
      expect.objectContaining({ start: 0, end: 4 }),
    );
    const play = vi.fn(() => ({ status: "ok" as const }));
    registerCommand("range.play", play);
    host(EDIT_SELECTIONS.rangeOnAllTracks);
    await runEditVerb("hear", factsOf()!);
    expect(play).toHaveBeenCalled();
  });

  it("starts a Replace take over a range and an Insert take at the playhead", async () => {
    const setTarget = vi.fn(() => ({ status: "ok" as const }));
    const open = vi.fn(() => ({ status: "ok" as const }));
    registerCommand("record.setTarget", setTarget);
    registerCommand("stage.record", open);
    host(EDIT_SELECTIONS.rangeOnAllTracks);
    await runEditVerb("record", factsOf()!);
    expect(setTarget).toHaveBeenLastCalledWith(
      {
        target: {
          kind: "replace",
          from_sec: 1,
          to_sec: 2,
          track_ids: [MIRA, JONAS],
        },
      },
      expect.anything(),
    );
    host(null, { playheadSec: 6 });
    await runEditVerb("record", factsOf()!);
    expect(setTarget).toHaveBeenLastCalledWith(
      { target: { kind: "insert", at_sec: 6 } },
      expect.anything(),
    );
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("refuses to record for a guest", async () => {
    host(null, { projectPath: "share:tok", guestMode: "edit" });
    const result = await runEditVerb("record", factsOf()!);
    expect(result).toEqual({
      status: "disabled",
      reason: "Only the host can record",
    });
  });

  it("mutes words, a range and a track each through its own command", async () => {
    const calls: string[] = [];
    for (const id of [
      "transcript.ignoreWords",
      "range.mute",
      "track.muteToggle",
    ])
      registerCommand(id, () => {
        calls.push(id);
        return { status: "ok" };
      });
    host(EDIT_SELECTIONS.liveWords);
    await runMute();
    host(EDIT_SELECTIONS.rangeOnAllTracks);
    await runMute();
    host({ kind: "track", trackId: MIRA });
    await runMute();
    expect(calls).toEqual([
      "transcript.ignoreWords",
      "range.mute",
      "track.muteToggle",
    ]);
  });

  it("mutes the targeted track, not the Edit selection, outside the Edit stage", async () => {
    const calls: string[] = [];
    for (const id of ["range.mute", "track.muteToggle"])
      registerCommand(id, () => {
        calls.push(id);
        return { status: "ok" };
      });
    host(EDIT_SELECTIONS.rangeOnAllTracks, { stage: "review" });
    await runMute();
    host(EDIT_SELECTIONS.clip, { stage: "review" });
    await runMute();
    expect(calls).toEqual(["track.muteToggle", "track.muteToggle"]);
    expect(runRangeAction).not.toHaveBeenCalled();
  });

  it("sends an Editor's word mute through the range mute, not the host-only ignore", async () => {
    const calls: string[] = [];
    for (const id of ["transcript.ignoreWords", "range.mute"])
      registerCommand(id, () => {
        calls.push(id);
        return { status: "ok" };
      });
    host(EDIT_SELECTIONS.liveWords, {
      projectPath: "share:tok",
      guestMode: "edit",
    });
    await runMute();
    expect(calls).toEqual(["range.mute"]);
  });

  it("mutes one clip's span and asks for one clip when several are held", async () => {
    host(EDIT_SELECTIONS.clip);
    await runMute();
    expect(runRangeAction).toHaveBeenCalledWith(
      "mute",
      expect.objectContaining({ intervals: [{ start: 0, end: 4 }] }),
    );
    host(EDIT_SELECTIONS.clips);
    expect(await runMute()).toEqual({
      status: "disabled",
      reason: "Select one clip to mute it",
    });
  });
});

describe("Inspect and More", () => {
  it("toggles the Inspector for the selection, and open: true never closes it", async () => {
    host(EDIT_SELECTIONS.clip);
    await execute("edit.inspect");
    expect(useDawStore.getState().inspectorKey).toBe("clip:a");
    await execute("edit.inspect", { open: true });
    expect(useDawStore.getState().inspectorKey).toBe("clip:a");
    await execute("edit.inspect");
    expect(useDawStore.getState().inspectorKey).toBeNull();
  });

  it("needs a selection to inspect", async () => {
    host(null);
    expect(await execute("edit.inspect")).toEqual({
      status: "disabled",
      reason: "Select something to inspect",
    });
  });

  it("opens More only where there are rows", async () => {
    host(EDIT_SELECTIONS.rangeOnAllTracks);
    const before = useDawStore.getState().moreRequest;
    await execute("edit.more");
    expect(useDawStore.getState().moreRequest).toBe(before + 1);
    host(EDIT_SELECTIONS.comment);
    expect(await execute("edit.more")).toEqual({
      status: "disabled",
      reason: "There are no more actions here",
    });
  });
});

describe("barModelOf", () => {
  const model = (selection: unknown, extra: Record<string, unknown> = {}) => {
    host(selection, extra);
    return barModelOf(factsOf()!, useDawStore.getState());
  };

  it("only offers verbs this slice wires, so no button is a dead end", () => {
    for (const [name, selection] of Object.entries(EDIT_SELECTIONS)) {
      const facts = (host(selection), factsOf()!);
      const { items, primary } = barModelOf(facts, useDawStore.getState());
      for (const item of items)
        expect(WIRED_VERBS[facts.kind], `${name}: ${item.id}`).toContain(
          item.id,
        );
      if (primary) expect(["cut", "shorten", "lower"]).toContain(primary.id);
    }
  });

  it("words a suggest link's cut and mute as suggestions", () => {
    const m = model(EDIT_SELECTIONS.rangeOnAllTracks, {
      projectPath: "share:tok",
      guestMode: "comment",
      shareCapabilities: ["view", "play", "comment", "suggest"],
    });
    expect(m.primary).toMatchObject({ id: "cut", label: "Suggest cut" });
    expect(m.more.find((row) => row.id === "mute")?.label).toBe("Suggest mute");
  });

  it("draws Comment disabled with its reason on a link that cannot comment", () => {
    const viewer = model(EDIT_SELECTIONS.rangeOnAllTracks, {
      projectPath: "share:tok",
      guestMode: "view",
      shareCapabilities: ["view", "play"],
    });
    expect(viewer.items.find((i) => i.id === "comment")).toMatchObject({
      disabledReason: "This share cannot add comments",
    });
    const commenter = model(EDIT_SELECTIONS.rangeOnAllTracks, {
      projectPath: "share:tok",
      guestMode: "comment",
      shareCapabilities: ["view", "play", "comment"],
    });
    expect(
      commenter.items.find((i) => i.id === "comment")?.disabledReason,
    ).toBeUndefined();
  });

  it("gates the primary on a busy range and a join in flight", () => {
    expect(
      model(EDIT_SELECTIONS.rangeOnAllTracks, { rangeBusy: true }).primary
        ?.disabledReason,
    ).toBe("Range action in progress");
    expect(
      model(EDIT_SELECTIONS.rangeOnAllTracks, { joinMutationInFlight: true })
        .primary?.disabledReason,
    ).toBe("Wait for the join edit");
  });

  it("gives a link that cannot edit only Hear and Comment, and Hear plays the full mix", () => {
    const m = model(EDIT_SELECTIONS.rangeOnAllTracks, {
      projectPath: "share:tok",
      guestMode: "view",
      shareCapabilities: ["view", "play"],
    });
    expect(m.items).toEqual([
      { id: "hear", label: "Play full mix" },
      { id: "comment", disabledReason: "This share cannot add comments" },
    ]);
    expect(m.primary).toBeNull();
  });

  it("holds Export for the host only", () => {
    const guest = model(EDIT_SELECTIONS.rangeOnAllTracks, {
      projectPath: "share:tok",
      guestMode: "edit",
      shareCapabilities: ["view", "play", "comment", "suggest", "edit"],
    });
    expect(guest.items.map((item) => item.id)).not.toContain("record");
  });
});
