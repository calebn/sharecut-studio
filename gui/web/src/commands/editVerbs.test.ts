import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { playPendingPreview } from "../audio/pendingPreview";
import type { EditFacts } from "../edit/editSelection";
import { useDawStore } from "../state/dawStore";
import { barDisplay } from "../system/editActionSets";
import {
  EDIT_SELECTIONS,
  editFixtureProject,
  JONAS,
  MIRA,
} from "../test/actionBarFixtures";
import {
  appliedEditRecord,
  clipRow,
  editBoundaries,
  minimalProject,
} from "../test/fixtures";
import { HISTORY_ROOT_ID } from "../types/project";
import {
  barModelOf,
  currentEditFacts as factsOf,
  runEditVerb,
  runMute,
  splitPlan,
  WIRED_VERBS,
} from "./editVerbs";
import { clearRegisteredCommands, execute, registerCommand } from "./execute";
import { executePointerCommand } from "./pointer";
import { _resetSingleFlightsForTests, registerDawCommands } from "./register";
import { EDITING_OFF_REASON } from "./seamCommands";

vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  deleteClips: vi.fn(async () => "h-delete"),
  deleteChapter: vi.fn(async () => undefined),
  deleteSocialClip: vi.fn(async () => "h-social"),
  deleteComment: vi.fn(async () => "h-comment"),
  patchComment: vi.fn(async () => null),
  removeTrackCommand: vi.fn(async () => ({ history_head_id: "h-remove" })),
  applyFadeRecommendations: vi.fn(async () => undefined),
  setEnvelope: vi.fn(async () => "h-env"),
  approveEdits: vi.fn(),
  rejectEdits: vi.fn(),
  applySuggestedActions: vi.fn(),
  splitAtTime: vi.fn(
    async (
      _path: string,
      at: number,
      _tracks?: string[] | null,
      _reason?: string | null,
      extra: readonly number[] = [],
    ) => ({
      kind: "split" as const,
      pieces: null,
      times: [at, ...extra] as const,
      undo: "h-split",
    }),
  ),
  setTranscriptWordsIgnored: vi.fn(async () => "h-ignore"),
  setClipJoin: vi.fn(async () => undefined),
}));

const runRangeAction = vi.hoisted(() =>
  vi.fn(async (): Promise<{ status: "ok" }> => ({ status: "ok" })),
);
vi.mock("./rangeActions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rangeActions")>()),
  runRangeAction,
}));

vi.mock("../audio/pendingPreview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../audio/pendingPreview")>()),
  playPendingPreview: vi.fn(),
}));

const bleed = vi.hoisted(() => ({
  region: undefined as
    | { timelineSpan: { start: number; end: number } }
    | undefined,
  reason: undefined as string | undefined,
}));
vi.mock("./clipBleed", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./clipBleed")>()),
  selectedBleedRegion: () => bleed.region,
  bleedKeepReason: () => bleed.reason,
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
    rangeDraft: null,
    rangeBusy: false,
    joinMutationInFlight: false,
    playheadSec: 1,
    pendingRecordTarget: null,
    statusAnnouncement: "",
    ...extra,
  });
}

const announced = () => useDawStore.getState().statusAnnouncement;

const RESTORE_WORDS = {
  kind: "transcriptRange",
  trackId: MIRA,
  startWordIndex: 2,
  endWordIndex: 3,
} as const;

function wordsProject(ignored: readonly [boolean, boolean] = [true, true]) {
  const project = editFixtureProject();
  const utterance = project.transcript?.utterances[0];
  if (!utterance) throw new Error("The fixture has no words");
  return {
    ...project,
    meta: {
      ...project.meta,
      hydration: { transcript_words: true, history_groups: true },
    },
    transcript: {
      ...project.transcript,
      utterances: [
        {
          ...utterance,
          start: 7,
          end: 9,
          text: "this now",
          words: [
            {
              text: "this",
              start: 7,
              end: 8,
              word_index: 2,
              ignored: ignored[0],
            },
            {
              text: "now",
              start: 8,
              end: 9,
              word_index: 3,
              ignored: ignored[1],
            },
          ],
        },
      ],
    },
  };
}

beforeEach(() => {
  _resetSingleFlightsForTests();
  vi.clearAllMocks();
  clearRegisteredCommands();
  registerDawCommands();
});

const draftOn = (trackId: string) => ({
  start: 0,
  end: 5,
  trackIds: [trackId],
});

describe("host words Restore", () => {
  it("enables Restore without audible words and sends one guarded mutation with Undo", async () => {
    host(RESTORE_WORDS, { project: wordsProject() });
    const model = barModelOf(factsOf()!, useDawStore.getState());
    expect(model.more.find((item) => item.id === "mute")).toEqual({
      id: "mute",
      label: "Restore ignored words",
    });
    expect(model.primary?.disabledReason).toBe("Choose a range");
    expect(await runMute()).toEqual({ status: "ok" });
    expect(api.setTranscriptWordsIgnored).toHaveBeenCalledExactlyOnceWith(
      "/tmp/episode",
      MIRA,
      2,
      3,
      false,
      "this now",
    );
    expect(useDawStore.getState().feedbackToast).toMatchObject({
      message: "Restored selection",
      undo: "h-ignore",
    });
  });

  it.each([
    ["range busy", { rangeBusy: true }, "Range action in progress"],
    ["join busy", { joinMutationInFlight: true }, "Wait for the join edit"],
  ] as const)(
    "retains the %s refusal in both row and dispatch",
    async (_name, state, reason) => {
      host(RESTORE_WORDS, { project: wordsProject(), ...state });
      expect(
        barModelOf(factsOf()!, useDawStore.getState()).more.find(
          (item) => item.id === "mute",
        )?.disabledReason,
      ).toBe(reason);
      expect(await runMute()).toEqual({ status: "disabled", reason });
      expect(api.setTranscriptWordsIgnored).not.toHaveBeenCalled();
    },
  );

  it("retains hydration and unloaded-project refusals", async () => {
    const project = wordsProject();
    project.meta.hydration.transcript_words = false;
    host(RESTORE_WORDS, { project });
    expect(
      barModelOf(factsOf()!, useDawStore.getState()).more.find(
        (item) => item.id === "mute",
      )?.disabledReason,
    ).toBe("Transcript words not loaded");
    expect(await runMute()).toEqual({
      status: "disabled",
      reason: "Transcript words not loaded",
    });
    useDawStore.setState({ project: null });
    expect(await runMute()).toEqual({
      status: "disabled",
      reason: "No project loaded",
    });
    expect(api.setTranscriptWordsIgnored).not.toHaveBeenCalled();
  });

  it("keeps mixed words on Mute and preserves their captured text", async () => {
    host(RESTORE_WORDS, { project: wordsProject([true, false]) });
    const row = barModelOf(factsOf()!, useDawStore.getState()).more.find(
      (item) => item.id === "mute",
    );
    expect(row?.label ?? barDisplay("mute").label).toBe("Mute");
    expect(row?.disabledReason).toBeUndefined();
    expect(await runMute()).toEqual({ status: "ok" });
    expect(api.setTranscriptWordsIgnored).toHaveBeenCalledExactlyOnceWith(
      "/tmp/episode",
      MIRA,
      2,
      3,
      true,
      "this now",
    );
  });

  it.each([
    ["edit", ["view", "play", "comment", "edit"]],
    ["view", ["view", "play"]],
  ] as const)(
    "does not give the %s share the host Restore exception",
    async (guestMode, capabilities) => {
      host(RESTORE_WORDS, {
        project: wordsProject(),
        projectPath: "share:tok",
        guestMode,
        shareCapabilities: [...capabilities],
      });
      const row = barModelOf(factsOf()!, useDawStore.getState()).more.find(
        (item) => item.id === "mute",
      );
      expect(row?.label).not.toBe("Restore ignored words");
      if (guestMode === "edit")
        expect(row?.disabledReason).toBe("Choose a range");
      else expect(row).toBeUndefined();
      expect((await runMute()).status).toBe("disabled");
      expect(api.setTranscriptWordsIgnored).not.toHaveBeenCalled();
    },
  );

  it("keeps a fully ignored selection outside Edit on the track command", async () => {
    const track = vi.fn(() => ({ status: "ok" as const }));
    registerCommand("track.muteToggle", track);
    host(RESTORE_WORDS, { project: wordsProject(), stage: "review" });
    expect(await runMute()).toEqual({ status: "ok" });
    expect(track).toHaveBeenCalledOnce();
    expect(api.setTranscriptWordsIgnored).not.toHaveBeenCalled();
  });

  it("retains single flight while Restore is pending", async () => {
    let release: () => void = () => {};
    vi.mocked(api.setTranscriptWordsIgnored).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(null);
        }),
    );
    host(RESTORE_WORDS, { project: wordsProject() });
    const first = runMute();
    expect(await runMute()).toEqual({
      status: "disabled",
      reason: "Ignore already in progress",
    });
    release();
    expect(await first).toEqual({ status: "ok" });
    expect(api.setTranscriptWordsIgnored).toHaveBeenCalledOnce();
  });

  it("retains the stale-text refusal from the existing word command", async () => {
    vi.mocked(api.setTranscriptWordsIgnored).mockRejectedValueOnce(
      new Error("Selected words changed"),
    );
    host(RESTORE_WORDS, { project: wordsProject() });
    expect(await runMute()).toEqual({
      status: "disabled",
      reason: "Selected words changed",
      told: true,
    });
    expect(api.setTranscriptWordsIgnored).toHaveBeenCalledExactlyOnceWith(
      "/tmp/episode",
      MIRA,
      2,
      3,
      false,
      "this now",
    );
    expect(announced()).toBe("Ignore failed: Selected words changed");
  });
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

  it("cuts the selected word's mapped edges on its own track", () => {
    const f = facts(EDIT_SELECTIONS.liveWords);
    expect(splitPlan(f, EDIT_SELECTIONS.liveWords, project, 9)).toEqual({
      atTime: 7,
      extraAtTimes: [8],
      trackIds: [MIRA],
    });
  });

  it("uses the tracks the selection covers, whatever unconfirmed ticks say", () => {
    useDawStore.setState({ rangeDraft: draftOn(MIRA) });
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
  it("sends both selected-word edges in one history-producing request", async () => {
    host(EDIT_SELECTIONS.liveWords);
    await runEditVerb("split", factsOf()!);
    expect(api.splitAtTime).toHaveBeenCalledTimes(1);
    expect(api.splitAtTime).toHaveBeenCalledWith(
      "/tmp/episode",
      7,
      [MIRA],
      null,
      [8],
    );
    expect(announced()).toBe("Split at 00:07.000 and 00:08.000");
  });

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

describe("edit verb refusal ownership", () => {
  it("preserves a handler-owned announcement through public dispatch", async () => {
    const result = {
      status: "disabled",
      reason: "generic refusal",
      told: true,
    } as const;
    host(EDIT_SELECTIONS.clip);
    registerCommand("edit.delete", async () => {
      useDawStore
        .getState()
        .announceStatus("Mute failed: project changed", { tone: "error" });
      return result;
    });
    const announce = vi.spyOn(useDawStore.getState(), "announceStatus");

    await runEditVerb("cut", factsOf()!);

    expect(announce).toHaveBeenCalledExactlyOnceWith(
      "Mute failed: project changed",
      { tone: "error" },
    );
    expect(announced()).toBe("Mute failed: project changed");
  });

  it("announces an untold refusal", async () => {
    registerCommand("edit.delete", async () => ({
      status: "disabled",
      reason: "generic refusal",
    }));
    host(EDIT_SELECTIONS.clip);
    useDawStore
      .getState()
      .announceStatus("Saved edit", { undo: HISTORY_ROOT_ID });
    const announce = vi.spyOn(useDawStore.getState(), "announceStatus");
    announce.mockClear();

    const result = await runEditVerb("cut", factsOf()!);

    expect(result).toEqual({ status: "disabled", reason: "generic refusal" });
    expect(announce).toHaveBeenCalledExactlyOnceWith("generic refusal", {
      tone: "error",
    });
    expect(announced()).toBe("generic refusal");
  });

  it("leaves a standing Undo toast alone for an intentionally quiet refusal", async () => {
    registerCommand("edit.delete", async () => ({
      status: "disabled",
      reason: "Project changed during refresh",
      told: true,
    }));
    host(EDIT_SELECTIONS.clip);
    useDawStore
      .getState()
      .announceStatus("Saved edit", { undo: HISTORY_ROOT_ID });
    const announce = vi.spyOn(useDawStore.getState(), "announceStatus");
    announce.mockClear();

    const result = await runEditVerb("cut", factsOf()!);

    expect(result).toEqual({
      status: "disabled",
      reason: "Project changed during refresh",
      told: true,
    });
    expect(announce).not.toHaveBeenCalled();
    expect(useDawStore.getState().feedbackToast).toMatchObject({
      undo: HISTORY_ROOT_ID,
    });
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
    useDawStore.getState().setLayerVisible("showLevels", true);
    await execute("edit.delete");
    expect(vi.mocked(api.setEnvelope).mock.calls[0]?.[2]).toEqual([
      { id: "p1", time: 1, value: 1 },
    ]);
    expect(useDawStore.getState().selection).toEqual({
      kind: "envelope",
      trackId: MIRA,
    });
  });

  it("keeps an envelope point while the volume envelope is hidden", async () => {
    const project = minimalProject({
      tracks: editFixtureProject().tracks,
      envelopes: [
        {
          track_id: MIRA,
          parameter: "volume",
          points: [{ id: "p1", time: 1, value: 1 }],
        },
      ],
    });
    host({ kind: "envelopePoint", trackId: MIRA, pointId: "p1" }, { project });
    useDawStore.getState().setLayerVisible("showLevels", false);
    expect(await execute("edit.delete", {}, { skipWhen: true })).toEqual({
      status: "disabled",
      reason: "Show the volume envelope before changing points",
      told: true,
    });
    expect(announced()).toBe("Show the volume envelope before changing points");
    expect(api.setEnvelope).not.toHaveBeenCalled();
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

const jonasUtterance = (start: number, end: number) => ({
  track_id: JONAS,
  speaker: "Jonas",
  start,
  end,
  text: "yes",
  words: [
    {
      text: "yes",
      start,
      end,
      timeline_start: start,
      timeline_end: end,
      mappable: true,
      word_index: 0,
    },
  ],
});

describe("Backspace while playing with nothing selected", () => {
  const timelined = () => {
    const project = editFixtureProject();
    for (const u of project.transcript!.utterances)
      for (const w of u.words!) {
        w.timeline_start = w.start;
        w.timeline_end = w.end;
        w.mappable = true;
      }
    return project;
  };
  const playing = (extra: Record<string, unknown> = {}) =>
    host(null, {
      project: timelined(),
      isPlaying: true,
      playheadSec: 7.5,
      ...extra,
    });

  it("pauses in place and selects the word under the playhead", async () => {
    playing();
    expect(await execute("edit.delete")).toEqual({ status: "ok" });
    const s = useDawStore.getState();
    expect(s.isPlaying).toBe(false);
    expect(s.playheadSec).toBe(7.5);
    expect(s.selection).toMatchObject({
      kind: "transcriptRange",
      trackId: MIRA,
      startWordIndex: 2,
      endWordIndex: 2,
    });
    expect(announced()).toBe('Selected "this". Cut it to remove');
    expect(runRangeAction).not.toHaveBeenCalled();
  });

  it("cuts the selected word on the second press, through the range cut", async () => {
    playing();
    await execute("edit.delete");
    await execute("edit.delete");
    expect(runRangeAction).toHaveBeenCalledOnce();
    expect(runRangeAction).toHaveBeenCalledWith("cut");
  });

  it("takes a word that ended within a second before the playhead", async () => {
    const project = timelined();
    const first = project.transcript!.utterances[0]!.words![0]!;
    playing({ project, playheadSec: first.end + 0.5 });
    await execute("edit.delete");
    expect(useDawStore.getState().selection).toMatchObject({
      startWordIndex: 0,
    });
  });

  it("refuses in a silence longer than a second and keeps playing", async () => {
    const project = timelined();
    const first = project.transcript!.utterances[0]!.words![0]!;
    playing({ project, playheadSec: first.end + 1.5 });
    expect(await execute("edit.delete", {}, { skipWhen: true })).toEqual({
      status: "disabled",
      reason: "No word under the playhead",
    });
    expect(useDawStore.getState().isPlaying).toBe(true);
    expect(useDawStore.getState().selection).toBeNull();
  });

  it("prefers the word at the playhead on a lower track over a stale word above", async () => {
    const project = timelined();
    project.transcript!.utterances.push(jonasUtterance(7, 8));
    playing({ project, playheadSec: 7.5, rangeDraft: null });
    const mira = project.transcript!.utterances[0]!.words!;
    for (const w of mira) {
      w.timeline_start = 2;
      w.timeline_end = 2.2;
    }
    await execute("edit.delete");
    expect(useDawStore.getState().selection).toMatchObject({ trackId: JONAS });
  });

  it("falls back to a targeted track even when another track's word ended later", async () => {
    const project = timelined();
    project.transcript!.utterances.push(jonasUtterance(6.5, 7.2));
    for (const w of project.transcript!.utterances[0]!.words!) {
      w.timeline_start = 6.6;
      w.timeline_end = 6.8;
    }
    playing({ project, playheadSec: 7.5, rangeDraft: draftOn(MIRA) });
    await execute("edit.delete");
    expect(useDawStore.getState().selection).toMatchObject({ trackId: MIRA });
  });

  it("skips a muted targeted track", async () => {
    const project = timelined();
    project.transcript!.utterances.push(jonasUtterance(7, 8));
    playing({
      project,
      rangeDraft: draftOn(MIRA),
      viewerMute: { [MIRA]: true },
    });
    await execute("edit.delete");
    expect(useDawStore.getState().selection).toMatchObject({ trackId: JONAS });
  });

  it("prefers the targeted track, then the topmost audible one", async () => {
    const project = timelined();
    project.transcript!.utterances.push({
      track_id: JONAS,
      speaker: "Jonas",
      start: 7,
      end: 8,
      text: "yes",
      words: [
        {
          text: "yes",
          start: 7,
          end: 8,
          timeline_start: 7,
          timeline_end: 8,
          mappable: true,
          word_index: 0,
        },
      ],
    });
    playing({ project, rangeDraft: draftOn(JONAS) });
    await execute("edit.delete");
    expect(useDawStore.getState().selection).toMatchObject({ trackId: JONAS });
    playing({ project, viewerMute: { [MIRA]: true } });
    await execute("edit.delete");
    expect(useDawStore.getState().selection).toMatchObject({ trackId: JONAS });
  });

  it("keeps playing and says so when no word is under the playhead", async () => {
    playing({ playheadSec: 0.5 });
    expect(await execute("edit.delete", {}, { skipWhen: true })).toEqual({
      status: "disabled",
      reason: "No word under the playhead",
    });
    expect(useDawStore.getState().isPlaying).toBe(true);
    expect(useDawStore.getState().selection).toBeNull();
  });

  it("leaves the old refusal when not playing or outside Edit", async () => {
    host(null, { playheadSec: 7.5, isPlaying: false });
    expect(await execute("edit.delete")).toEqual({
      status: "disabled",
      reason: "No clip selected",
    });
    playing({ stage: "review" });
    expect((await execute("edit.delete", {}, { skipWhen: true })).status).toBe(
      "disabled",
    );
    expect(useDawStore.getState().isPlaying).toBe(true);
    expect(useDawStore.getState().selection).toBeNull();
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

describe("Hear and Seek on a suggestion", () => {
  function withEdit(overrides: Record<string, unknown>) {
    host(EDIT_SELECTIONS.suggestion);
    const project = useDawStore.getState().project!;
    useDawStore.setState({
      project: {
        ...project,
        pending_edits: project.pending_edits.map((edit) => ({
          ...edit,
          ...overrides,
        })),
      },
    });
  }

  it("plain Hear plays the suggested side", async () => {
    vi.mocked(playPendingPreview).mockResolvedValue({ status: "ok" } as never);
    withEdit({ suggest_reason: null });
    await runEditVerb("hear", factsOf()!);
    expect(playPendingPreview).toHaveBeenCalledWith(
      "/tmp/episode",
      "pending-cut",
      "suggested",
    );
  });

  it("plain Hear plays the current side where no suggested render exists", async () => {
    vi.mocked(playPendingPreview).mockResolvedValue({ status: "ok" } as never);
    withEdit({ suggest_reason: "A split does not change the mix." });
    await runEditVerb("hear", factsOf()!);
    expect(playPendingPreview).toHaveBeenCalledWith(
      "/tmp/episode",
      "pending-cut",
      "current",
    );
  });

  it("gives a read-only guest a Hear that plays the suggestion", async () => {
    vi.mocked(playPendingPreview).mockResolvedValue({ status: "ok" } as never);
    host(EDIT_SELECTIONS.suggestion, {
      projectPath: "share:tok",
      guestMode: "view",
      shareCapabilities: ["view", "play"],
    });
    const model = barModelOf(factsOf()!, useDawStore.getState());
    expect(model.items.map((item) => item.id)).toEqual(["hear", "comment"]);
    await runEditVerb("hear", factsOf()!);
    expect(playPendingPreview).toHaveBeenCalledWith(
      "share:tok",
      "pending-cut",
      expect.any(String),
    );
  });

  it("announces a refused preview in the status line", async () => {
    vi.mocked(playPendingPreview).mockResolvedValue({
      status: "disabled",
      reason: "This share cannot play audio",
    } as never);
    host(EDIT_SELECTIONS.suggestion);
    await runEditVerb("hear", factsOf()!);
    expect(announced()).toBe("This share cannot play audio");
  });

  it("offers Seek to start as a More row and moves the playhead to the suggestion", async () => {
    const seek = vi.fn((_args: Record<string, unknown>) => ({
      status: "ok" as const,
    }));
    registerCommand("transport.seek", seek);
    withEdit({ timeline_start: 7.5, source_start: 3 });
    const model = barModelOf(factsOf()!, useDawStore.getState());
    expect(model.more.map((row) => row.id)).toContain("seek");
    await runEditVerb("seek", factsOf()!);
    expect(seek.mock.calls.map((call) => call[0])).toEqual([{ sec: 7.5 }]);
  });

  it("seeks to the source start when the edit has no timeline start", async () => {
    const seek = vi.fn((_args: Record<string, unknown>) => ({
      status: "ok" as const,
    }));
    registerCommand("transport.seek", seek);
    withEdit({ timeline_start: undefined, source_start: 3 });
    await runEditVerb("seek", factsOf()!);
    expect(seek.mock.calls.map((call) => call[0])).toEqual([{ sec: 3 }]);
  });

  it("offers a read-only guest Copy on a word", () => {
    host(EDIT_SELECTIONS.liveWords, {
      projectPath: "share:tok",
      guestMode: "view",
      shareCapabilities: ["view", "play"],
    });
    const model = barModelOf(factsOf()!, useDawStore.getState());
    expect(model.items.map((item) => item.id)).toEqual([
      "hear",
      "comment",
      "more",
    ]);
    expect(model.more).toEqual([{ id: "copy" }]);
  });

  it("does not offer Seek to a read-only guest", () => {
    host(EDIT_SELECTIONS.suggestion, {
      projectPath: "share:tok",
      guestMode: "view",
      shareCapabilities: ["view", "play"],
    });
    expect(
      barModelOf(factsOf()!, useDawStore.getState()).more.map((r) => r.id),
    ).not.toContain("seek");
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

  it("parks a Replace target and opens Record on Re-record over a range", async () => {
    const open = vi.fn(() => ({ status: "ok" as const }));
    registerCommand("stage.record", open);
    host(EDIT_SELECTIONS.rangeOnAllTracks);
    await runEditVerb("record", factsOf()!);
    expect(useDawStore.getState().pendingRecordTarget).toEqual({
      kind: "replace",
      from_sec: 1,
      to_sec: 2,
      track_ids: [MIRA, JONAS],
    });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("parks the selected words as the script of a Re-record over words", async () => {
    registerCommand("stage.record", () => ({ status: "ok" as const }));
    host(EDIT_SELECTIONS.liveWords);
    await runEditVerb("record", factsOf()!);
    expect(useDawStore.getState().pendingRecordTarget).toEqual({
      kind: "replace",
      from_sec: 7,
      to_sec: 8,
      track_ids: [MIRA],
      script: "…this…",
    });
  });

  it("parks an Insert target at the playhead on Record here", async () => {
    const open = vi.fn(() => ({ status: "ok" as const }));
    registerCommand("stage.record", open);
    host(null, { playheadSec: 6 });
    await runEditVerb("record", factsOf()!);
    expect(useDawStore.getState().pendingRecordTarget).toEqual({
      kind: "insert",
      at_sec: 6,
    });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("parks an Insert target at the held time on record.here from the create menu", async () => {
    const open = vi.fn(() => ({ status: "ok" as const }));
    registerCommand("stage.record", open);
    host(null, { playheadSec: 6 });
    await executePointerCommand("record.here", { atTime: 3.5 });
    expect(useDawStore.getState().pendingRecordTarget).toEqual({
      kind: "insert",
      at_sec: 3.5,
    });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("refuses record.here with a time that is not a number and parks nothing", async () => {
    const open = vi.fn(() => ({ status: "ok" as const }));
    registerCommand("stage.record", open);
    host(null);
    for (const atTime of ["soon", "", true, -1, Number.NaN]) {
      const result = await executePointerCommand("record.here", { atTime });
      expect(result.status).toBe("disabled");
    }
    expect(useDawStore.getState().pendingRecordTarget).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it("opens Record without a target on Record here over an empty timeline", async () => {
    const open = vi.fn(() => ({ status: "ok" as const }));
    registerCommand("stage.record", open);
    const project = editFixtureProject();
    host(null, {
      project: {
        ...project,
        clips: {
          ...project.clips,
          tracks: Object.fromEntries(
            Object.keys(project.clips.tracks).map((id) => [id, []]),
          ),
        },
      },
    });
    await runEditVerb("record", factsOf()!);
    expect(useDawStore.getState().pendingRecordTarget).toBeNull();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("parks the target only after Record opened", async () => {
    let parkedWhenOpened: unknown = "unset";
    registerCommand("stage.record", () => {
      parkedWhenOpened = useDawStore.getState().pendingRecordTarget;
      return { status: "ok" as const };
    });
    host(EDIT_SELECTIONS.rangeOnAllTracks);
    await runEditVerb("record", factsOf()!);
    expect(parkedWhenOpened).toBeNull();
    expect(useDawStore.getState().pendingRecordTarget).not.toBeNull();
  });

  it("parks nothing when Record does not open", async () => {
    registerCommand("stage.record", () => ({
      status: "disabled" as const,
      reason: "No project loaded",
    }));
    host(EDIT_SELECTIONS.rangeOnAllTracks);
    const result = await runEditVerb("record", factsOf()!);
    expect(result.status).toBe("disabled");
    expect(useDawStore.getState().pendingRecordTarget).toBeNull();
  });

  it("offers Re-record only on a selection a take can replace", () => {
    host(EDIT_SELECTIONS.rangeOnAllTracks);
    const s = useDawStore.getState();
    const ids = (facts: EditFacts) =>
      barModelOf(facts, s).items.map((item) => item.id);
    expect(ids(factsOf()!)).toContain("record");
    expect(ids({ ...factsOf()!, span: null })).not.toContain("record");
    expect(
      ids({ ...factsOf()!, span: { start: 1, end: 2, trackIds: [] } }),
    ).not.toContain("record");
    expect(
      ids({ ...factsOf()!, span: { start: 1, end: 9999, trackIds: [MIRA] } }),
    ).not.toContain("record");
  });

  it("labels Record as Re-record over a range and Record here on the playhead", () => {
    host(EDIT_SELECTIONS.rangeOnAllTracks);
    const over = barModelOf(factsOf()!, useDawStore.getState()).items.find(
      (item) => item.id === "record",
    );
    expect(over?.label).toBe("Re-record");
    host(null, { playheadSec: 6 });
    const record = barModelOf(factsOf()!, useDawStore.getState()).items.find(
      (item) => item.id === "record",
    );
    expect(record?.label).toBe("Record here");
  });

  it("refuses to record for a guest", async () => {
    host(null, { projectPath: "share:tok", guestMode: "edit" });
    const result = await runEditVerb("record", factsOf()!);
    expect(result).toEqual({
      status: "disabled",
      reason: "Only the host can record",
    });
    expect(useDawStore.getState().pendingRecordTarget).toBeNull();
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

  it.each(["adjustBounds", "fade", "moveToTrack"] as const)(
    "%s keeps an open Inspector open",
    async (id) => {
      host(EDIT_SELECTIONS.clip);
      await execute("edit.inspect");
      await runEditVerb(id, factsOf()!);
      expect(useDawStore.getState().inspectorKey).toBe("clip:a");
    },
  );

  it("seeds a range draft at the playhead with nothing selected, and drops it when pressed again", async () => {
    host(null);
    expect(await execute("edit.inspect")).toEqual({ status: "ok" });
    expect(useDawStore.getState()).toMatchObject({
      rangeArmed: true,
      rangeDraft: { start: 1, end: 6, trackIds: [MIRA, JONAS] },
    });
    expect(await execute("edit.inspect")).toEqual({ status: "ok" });
    expect(useDawStore.getState()).toMatchObject({
      rangeArmed: false,
      rangeDraft: null,
    });
  });

  it("refuses to inspect on an empty timeline", async () => {
    host(null, { project: minimalProject() });
    expect(await execute("edit.inspect")).toEqual({
      status: "disabled",
      reason: "Nothing to select yet",
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
      if (primary)
        expect(["cut", "shorten", "lower", "approve", "resolve"]).toContain(
          primary.id,
        );
    }
  });

  it("names the words mute row Restore when every selected word is already ignored", () => {
    const row = (m: ReturnType<typeof model>) =>
      m.more.find((r) => r.id === "mute")?.label;
    expect(row(model(EDIT_SELECTIONS.liveWords))).toBeUndefined();
    const ignored = editFixtureProject();
    for (const u of ignored.transcript?.utterances ?? [])
      for (const w of u.words ?? [])
        if (w.word_index === 2) (w as { ignored?: boolean }).ignored = true;
    useDawStore.setState({ project: ignored });
    const restored = barModelOf(factsOf()!, useDawStore.getState());
    expect(row(restored)).toBe("Restore ignored words");
    expect(
      restored.more.find((item) => item.id === "mute")?.disabledReason,
    ).toBeUndefined();
    useDawStore.setState({
      selection: { ...EDIT_SELECTIONS.liveWords, startWordIndex: 0 },
    });
    const mixed = barModelOf(factsOf()!, useDawStore.getState()).more.find(
      (item) => item.id === "mute",
    );
    expect(mixed).toMatchObject({ id: "mute" });
    expect(mixed?.label ?? barDisplay("mute").label).toBe("Mute");
  });

  it.each([
    ["edit", ["view", "play", "comment", "edit"], "Mute"],
    ["comment", ["view", "play", "comment", "suggest"], "Suggest mute"],
  ] as const)(
    "keeps the exact mute label in the %s words model",
    (guestMode, shareCapabilities, expected) => {
      const ignored = editFixtureProject();
      for (const u of ignored.transcript?.utterances ?? [])
        for (const w of u.words ?? [])
          if (w.word_index === 2) (w as { ignored?: boolean }).ignored = true;
      host(EDIT_SELECTIONS.liveWords, {
        project: ignored,
        projectPath: "share:tok",
        guestMode,
        shareCapabilities: [...shareCapabilities],
      });
      const row = barModelOf(factsOf()!, useDawStore.getState()).more.find(
        (r) => r.id === "mute",
      );
      expect(row).toBeDefined();
      expect(row?.label ?? barDisplay("mute").label).toBe(expected);
    },
  );

  it("puts Hear, Remove, More and Inspect on a track, with the reorder rows in More and no Mute", () => {
    const first = model({ kind: "track", trackId: MIRA });
    expect(first.items.map((item) => item.id)).toEqual([
      "hear",
      "remove",
      "more",
      "inspect",
    ]);
    expect(first.more).toEqual([
      { id: "moveTrackUp", disabledReason: "This track is already first." },
      { id: "moveTrackDown" },
      { id: "smoothJoins" },
    ]);
    expect(model({ kind: "track", trackId: JONAS }).more).toEqual([
      { id: "moveTrackUp" },
      { id: "moveTrackDown", disabledReason: "This track is already last." },
      { id: "smoothJoins" },
    ]);
  });

  it("names the ingest gate before the list end on a track Move row", () => {
    expect(
      model(
        { kind: "track", trackId: MIRA },
        {
          projectPath: "share:tok",
          guestMode: "edit",
          shareCapabilities: ["view", "play", "suggest"],
        },
      ).more.map((row) => row.disabledReason),
    ).toEqual([
      "Media ingest not allowed",
      "Media ingest not allowed",
      EDITING_OFF_REASON,
    ]);
  });

  it("shows the ingest gate on Remove up front, like the Move rows", () => {
    const view = {
      projectPath: "share:tok",
      guestMode: "edit",
      shareCapabilities: ["view", "play", "suggest"],
    };
    expect(
      model({ kind: "track", trackId: MIRA }, view).items.find(
        (item) => item.id === "remove",
      ),
    ).toEqual({ id: "remove", disabledReason: "Media ingest not allowed" });
    expect(
      model({ kind: "track", trackId: MIRA }).items.find(
        (item) => item.id === "remove",
      ),
    ).toEqual({ id: "remove" });
  });

  it("names Select one track to remove on the bar when two tracks are held", () => {
    host({ kind: "track", trackId: MIRA });
    useDawStore.getState().selectTracks([MIRA, JONAS]);
    expect(
      barModelOf(factsOf()!, useDawStore.getState()).items.find(
        (item) => item.id === "remove",
      ),
    ).toEqual({ id: "remove", disabledReason: "Select one track to remove" });
  });

  it("hears the track from the playhead when it sits inside the track, else from its first clip", async () => {
    host({ kind: "track", trackId: MIRA });
    const clips = editFixtureProject().clips.tracks[MIRA]!;
    const first = Math.min(...clips.map((c) => c.timeline_start));
    const last = Math.max(...clips.map((c) => c.timeline_end));
    useDawStore.setState({ playheadSec: last + 100 });
    await runEditVerb("hear", factsOf()!);
    expect(playRange).toHaveBeenLastCalledWith(
      expect.objectContaining({ start: first, end: Math.min(last, first + 6) }),
    );
  });

  it("says a track with no clips has nothing to hear", async () => {
    const project = editFixtureProject();
    project.clips.tracks[MIRA] = [];
    host({ kind: "track", trackId: MIRA }, { project });
    expect(await runEditVerb("hear", factsOf()!)).toEqual({
      status: "disabled",
      reason: "This track has no audio to hear",
    });
  });

  it("smooths every join on the selected track from More", async () => {
    host({ kind: "track", trackId: MIRA });
    expect(await runEditVerb("smoothJoins", factsOf()!)).toEqual({
      status: "ok",
    });
    expect(api.applyFadeRecommendations).toHaveBeenCalledExactlyOnceWith(
      "/tmp/episode",
      MIRA,
    );
  });

  it("refuses Smooth all joins on two tracks and announces a host refusal in the error tone", async () => {
    host({ kind: "track", trackId: MIRA });
    useDawStore.getState().selectTracks([MIRA, JONAS]);
    expect(await runEditVerb("smoothJoins", factsOf()!)).toMatchObject({
      status: "disabled",
      reason: "Select one track to smooth its joins",
    });
    host({ kind: "track", trackId: MIRA });
    vi.mocked(api.applyFadeRecommendations).mockRejectedValueOnce(
      new Error("no fades"),
    );
    expect(await runEditVerb("smoothJoins", factsOf()!)).toMatchObject({
      status: "disabled",
      reason: "no fades",
    });
    expect(useDawStore.getState().feedbackToast).toMatchObject({
      message: "no fades",
      tone: "error",
    });
  });

  it("removes the selected track from the bar with an Undo toast, and refuses two tracks", async () => {
    host({ kind: "track", trackId: MIRA });
    await runEditVerb("remove", factsOf()!);
    expect(api.removeTrackCommand).toHaveBeenCalledWith("/tmp/episode", MIRA);
    expect(useDawStore.getState().feedbackToast).toMatchObject({
      message: "Removed Mira",
      undo: "h-remove",
    });
    vi.mocked(api.removeTrackCommand).mockClear();
    host(null);
    useDawStore.getState().selectTracks([MIRA, JONAS]);
    await runEditVerb("remove", factsOf()!);
    expect(api.removeTrackCommand).not.toHaveBeenCalled();
    expect(announced()).toBe("Select one track to remove");
  });

  it("offers Split on a words selection", () => {
    expect(model(EDIT_SELECTIONS.liveWords).items.map((i) => i.id)).toContain(
      "split",
    );
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

describe("seam bar", () => {
  const lane = (overrides: Record<string, unknown> = {}) => [
    clipRow({
      id: "x",
      track_id: MIRA,
      source_start: 0,
      source_end: 4,
      timeline_start: 0,
      timeline_end: 4,
    }),
    clipRow({
      id: "y",
      track_id: MIRA,
      source_start: 6,
      source_end: 10,
      timeline_start: 4,
      timeline_end: 8,
      ...overrides,
    }),
  ];

  function seamProject(
    clips: ReturnType<typeof lane>,
    records: ReturnType<typeof appliedEditRecord>[] = [],
  ) {
    return minimalProject({
      tracks: editFixtureProject().tracks,
      clips: { tracks: { [MIRA]: clips }, clip_count: clips.length },
      applied_edits: { count: records.length, records },
      edit_boundaries: editBoundaries(clips),
    });
  }

  const cut = () =>
    appliedEditRecord({
      track_ids: [MIRA],
      source_start: 4,
      source_end: 6,
      restore: { state: "ready" },
    });

  const bar = (project: ReturnType<typeof seamProject>, extra = {}) => {
    host({ kind: "seam", id: "eb:x:y", trackId: MIRA }, { project, ...extra });
    return barModelOf(factsOf()!, useDawStore.getState());
  };

  it("lists Hear, Join type, Keep, Comment, Inspect on a cut seam", () => {
    const { items } = bar(seamProject(lane(), [cut()]));
    expect(items.map((item) => item.id)).toEqual([
      "hear",
      "joinType",
      "keep",
      "comment",
      "inspect",
    ]);
    const join = items.find((item) => item.id === "joinType");
    expect(join?.options?.map((option) => option.value)).toEqual([
      "cut",
      "fade",
      "crossfade",
    ]);
    expect(join?.options?.filter((o) => o.pressed)).toHaveLength(1);
  });

  it("has no Keep on a split seam", () => {
    const { items } = bar(seamProject(lane({ source_start: 4 })));
    expect(items.map((item) => item.id)).toEqual([
      "hear",
      "joinType",
      "comment",
      "inspect",
    ]);
  });

  it("has no Join type on a gapped seam", () => {
    const { items } = bar(
      seamProject(lane({ timeline_start: 5, timeline_end: 9 }), [cut()]),
    );
    expect(items.map((item) => item.id)).not.toContain("joinType");
  });

  it("omits Crossfade when the join cannot blend", () => {
    const { items } = bar(
      seamProject(lane({ join_crossfade_blocked: "no_headroom" }), [cut()]),
    );
    expect(
      items
        .find((item) => item.id === "joinType")
        ?.options?.map((option) => option.value),
    ).toEqual(["cut", "fade"]);
  });

  it("keeps Crossfade offered while the join is already a crossfade", () => {
    const { items } = bar(
      seamProject(
        lane({
          join_in_mode: "crossfade",
          join_crossfade_blocked: "no_headroom",
        }),
        [cut()],
      ),
    );
    const options = items.find((item) => item.id === "joinType")?.options;
    expect(options?.find((option) => option.pressed)?.value).toBe("crossfade");
  });

  it("has no Join type for a guest without edit capability", () => {
    const { items } = bar(seamProject(lane(), [cut()]), {
      projectPath: "share:tok",
      guestMode: "comment",
      shareCapabilities: ["view", "play", "comment"],
    });
    expect(items.map((item) => item.id)).not.toContain("joinType");
  });

  it("shows Keep disabled with the reason when the cut is only in History", () => {
    const history = { ...cut(), restore: { state: "history_only" as const } };
    const keep = bar(seamProject(lane(), [history])).items.find(
      (item) => item.id === "keep",
    );
    expect(keep?.disabledReason).toBe("Undo this in History");
  });

  it("shows Keep disabled when the blocked record names no blocker", () => {
    const orphan = {
      ...cut(),
      restore: {
        state: "blocked" as const,
        code: "span_not_present" as const,
        message: "The audio is no longer there",
        blocked_by: [],
      },
    };
    const keep = bar(seamProject(lane(), [orphan])).items.find(
      (item) => item.id === "keep",
    );
    expect(keep?.disabledReason).toBe("The audio is no longer there");
  });

  it("shows Keep disabled on a link that can only suggest", () => {
    const keep = bar(seamProject(lane(), [cut()]), {
      projectPath: "share:tok",
      guestMode: "comment",
      shareCapabilities: ["view", "play", "comment", "suggest"],
    }).items.find((item) => item.id === "keep");
    expect(keep?.disabledReason).toBe("Editing is off for this link");
  });

  it("replays the seam after a join type change while its sheet is open", async () => {
    host(
      { kind: "seam", id: "eb:x:y", trackId: MIRA },
      {
        project: seamProject(lane(), [cut()]),
        inspectorKey: "seam:eb:x:y",
        isPlaying: false,
      },
    );
    playRange.mockClear();
    expect(await runEditVerb("joinType", factsOf()!, "crossfade")).toEqual({
      status: "ok",
    });
    expect(api.setClipJoin).toHaveBeenCalled();
    expect(playRange).toHaveBeenCalledTimes(1);
  });

  it("does not replay a join type change while the sheet is closed", async () => {
    host(
      { kind: "seam", id: "eb:x:y", trackId: MIRA },
      { project: seamProject(lane(), [cut()]), isPlaying: false },
    );
    playRange.mockClear();
    await runEditVerb("joinType", factsOf()!, "crossfade");
    expect(playRange).not.toHaveBeenCalled();
  });

  it("leaves Keep enabled when every record is ready", () => {
    const keep = bar(seamProject(lane(), [cut()])).items.find(
      (item) => item.id === "keep",
    );
    expect(keep?.disabledReason).toBeUndefined();
  });
});

describe("comment, bleed and social verbs", () => {
  const BLEED = {
    kind: "bleedAttenuation",
    id: "a",
    trackId: MIRA,
    regionKey: "k",
  } as const;

  beforeEach(() => {
    bleed.region = { timelineSpan: { start: 2, end: 4 } };
    bleed.reason = undefined;
  });

  it("offers Undo on a resolve that reopens the comment", async () => {
    host(EDIT_SELECTIONS.comment);
    await runEditVerb("resolve", factsOf()!);
    const reverse = useDawStore.getState().feedbackToast?.reverse;
    expect(reverse?.done).toBe("Comment reopened");
    vi.mocked(api.patchComment).mockClear();
    await reverse?.run();
    expect(api.patchComment).toHaveBeenCalledWith(
      "/tmp/episode",
      "open",
      expect.objectContaining({ resolved: false }),
    );
  });

  it("resolves an open comment from the primary verb and says so", async () => {
    host(EDIT_SELECTIONS.comment);
    const facts = factsOf()!;
    expect(barModelOf(facts, useDawStore.getState()).primary).toMatchObject({
      id: "resolve",
    });
    await runEditVerb("resolve", facts);
    expect(api.patchComment).toHaveBeenCalledWith(
      "/tmp/episode",
      "open",
      expect.objectContaining({ resolved: true, by: expect.any(String) }),
    );
    expect(announced()).toBe("Comment resolved");
  });

  it("offers no resolve on a resolved comment and refuses it to a non-host", () => {
    host({ kind: "comment", id: "done" });
    expect(barModelOf(factsOf()!, useDawStore.getState()).primary).toBeNull();
    host(EDIT_SELECTIONS.comment, {
      projectPath: "share:tok",
      guestMode: "edit",
      shareCapabilities: ["edit"],
    });
    expect(
      barModelOf(factsOf()!, useDawStore.getState()).primary,
    ).toMatchObject({
      id: "resolve",
      disabledReason: "Only the host can resolve a comment",
    });
  });

  it("removes a comment with Undo and clears the selection", async () => {
    host(EDIT_SELECTIONS.comment);
    expect(
      barModelOf(factsOf()!, useDawStore.getState()).items.map((i) => i.id),
    ).toEqual(["remove", "inspect"]);
    await runEditVerb("remove", factsOf()!);
    expect(api.deleteComment).toHaveBeenCalledWith("/tmp/episode", "open");
    expect(useDawStore.getState().selection).toBeNull();
    expect(useDawStore.getState().feedbackToast).toMatchObject({
      message: "Comment removed",
      undo: "h-comment",
    });
  });

  it("refuses to remove a comment off the host", async () => {
    host(EDIT_SELECTIONS.comment, {
      projectPath: "share:tok",
      guestMode: "edit",
      shareCapabilities: ["edit"],
    });
    const result = await runEditVerb("remove", factsOf()!);
    expect(result).toMatchObject({
      status: "disabled",
      reason: "Only the host can remove a comment",
    });
    expect(api.deleteComment).not.toHaveBeenCalled();
  });

  it("removes a social clip with Undo, as the sheet's Delete did", async () => {
    host({ kind: "social", id: "s1" });
    await runEditVerb("remove", factsOf()!);
    expect(api.deleteSocialClip).toHaveBeenCalledWith("/tmp/episode", "s1");
    expect(useDawStore.getState().feedbackToast).toMatchObject({
      message: "Social clip removed",
      undo: "h-social",
    });
  });

  it("draws Hear before, Hear after and Keep on an automatic region", () => {
    host(BLEED);
    expect(barModelOf(factsOf()!, useDawStore.getState()).items).toEqual([
      { id: "hearBefore" },
      { id: "hearAfter" },
      { id: "keep" },
      { id: "inspect" },
    ]);
  });

  it("gives Keep the reason the region cannot be restored", () => {
    host(BLEED);
    bleed.reason = "Select one automatic region below.";
    expect(
      barModelOf(factsOf()!, useDawStore.getState()).items.find(
        (i) => i.id === "keep",
      ),
    ).toEqual({
      id: "keep",
      disabledReason: "Select one automatic region below.",
    });
  });

  it("plays the region from the source for Hear before and from the mix for Hear after", async () => {
    host(BLEED);
    await runEditVerb("hearBefore", factsOf()!);
    expect(useDawStore.getState().auditionMode).toBe("raw");
    expect(playRange).toHaveBeenLastCalledWith(
      expect.objectContaining({ start: 2, end: 4, padSec: 1 }),
    );
    await runEditVerb("hearAfter", factsOf()!);
    expect(useDawStore.getState().auditionMode).toBe("mix");
    expect(playRange).toHaveBeenCalledTimes(2);
  });

  it("asks for a region before Hear", async () => {
    host(BLEED);
    bleed.region = undefined;
    const result = await runEditVerb("hearBefore", factsOf()!);
    expect(result).toMatchObject({
      status: "disabled",
      reason: "Select one automatic region below",
    });
    expect(playRange).not.toHaveBeenCalled();
  });

  it("restores the selected region through the Restore command on Keep", async () => {
    host(BLEED);
    const restore = vi.fn(() => ({ status: "ok" as const }));
    registerCommand("edit.restoreClipBleed", restore);
    await runEditVerb("keep", factsOf()!);
    expect(restore).toHaveBeenCalledOnce();
  });
});
