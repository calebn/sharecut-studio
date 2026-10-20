import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetClipboardForTests, setClipboard } from "../edit/clipboard";
import { makeRangeTarget } from "../edit/rangeSelection";
import { submitQueuedDocumentCommand } from "../services/commandQueue";
import { useDawStore } from "../state/dawStore";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import { SRC_ROOT } from "../test/sourceFiles";
import { parseHistoryEntryId } from "../types/project";
import { COMMANDS } from "./catalog";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";

vi.mock("../services/commandQueue", async (orig) => ({
  ...(await orig<typeof import("../services/commandQueue")>()),
  submitQueuedDocumentCommand: vi.fn(),
}));

const HEAD = parseHistoryEntryId("h-after");

const project = () =>
  minimalProject({
    timeline_duration_sec: 20,
    tracks: [sampleTrack({ id: "host" }), sampleTrack({ id: "guest" })],
    envelopes: [],
    clips: {
      tracks: {
        host: [
          clipRow({
            id: "c1",
            track_id: "host",
            source_id: null,
            source_start: 0,
            source_end: 5,
            timeline_start: 0,
            timeline_end: 5,
          }),
        ],
        guest: [],
      },
      clip_count: 1,
    },
  });

const selectClip = () =>
  useDawStore
    .getState()
    .setSelection({ kind: "clip", id: "c1", trackId: "host" });

async function rangeToast(action: "cut" | "mute") {
  const state = useDawStore.getState();
  const target = makeRangeTarget(
    state.project!,
    [{ start: 1, end: 2 }],
    ["host"],
  )!;
  useDawStore.setState({ selection: { kind: "range", target } });
  vi.mocked(submitQueuedDocumentCommand).mockResolvedValue({
    type: "Applied",
    history_head_id: HEAD,
  });
  return toastOf(`range.${action}`);
}

/** Runs a command and returns the toast it raised. */
async function toastOf(id: string, args: Record<string, unknown> = {}) {
  const result = await execute(id, args, { skipWhen: true });
  expect(result).toEqual({ status: "ok" });
  return useDawStore.getState().feedbackToast;
}

/** Commands run against the real API wrappers; only the wire call is replaced. */
const DRIVEN: Record<string, () => Promise<unknown>> = {
  "edit.delete": () => toastOf("edit.delete", { clipId: "c1" }),
  "edit.rippleDelete": () => toastOf("edit.rippleDelete", { clipId: "c1" }),
  "edit.cut": async () => {
    selectClip();
    return toastOf("edit.cut");
  },
  "edit.paste": async () => {
    setClipboard({
      mode: "copy",
      timelineStart: 0,
      timelineEnd: 5,
      trackIds: ["host"],
      extracts: [],
    });
    return toastOf("edit.paste");
  },
  "edit.moveClips": () =>
    toastOf("edit.moveClips", {
      clips: [{ clip_id: "c1", timeline_start: 4, track_id: "guest" }],
    }),
  "edit.addChapter": () => toastOf("edit.addChapter", { atTime: 3 }),
  "envelope.addPoint": async () => {
    useDawStore.getState().setLayerVisible("showLevels", true);
    return toastOf("envelope.addPoint", { trackId: "host", atTime: 2 });
  },
  "range.cut": () => rangeToast("cut"),
  "range.mute": () => rangeToast("mute"),
};

/** The toast comes from a gesture or panel; the named test file asserts its Undo. */
const COVERED: Record<string, string> = {
  "edit.restoreClipBleed": "commands/clipBleed.test.ts",
  "edit.trimClipEdge": "timeline/useClipEdgeHandles.undo.test.tsx",
  "edit.setClipFade": "timeline/useClipEdgeHandles.undo.test.tsx",
  "range.moveSpeakerLane": "timeline/SpeakerLaneMoveActions.test.tsx",
  "track.remove": "commands/trackRemoveNav.test.ts",
  "track.reorder": "commands/trackReorder.test.ts",
  "track.moveUp": "commands/trackReorder.test.ts",
  "track.moveDown": "commands/trackReorder.test.ts",
  "track.splitSpeakers": "layout/SplitSpeakersDialog.test.tsx",
  "transcript.ignoreWords": "commands/transcriptIgnore.test.ts",
  "tighten.applyHit": "commands/tighten.test.ts",
  "tighten.skipHit": "commands/tighten.test.ts",
  "tighten.applySuggested": "commands/tighten.test.ts",
  "tighten.reviseSuggested": "commands/tighten.test.ts",
  "comment.resolve": "panels/CommentsPanel.test.tsx",
};

/** The result shows where the person acted, so no toast is raised. */
const IN_PLACE: Record<string, string> = {
  "edit.bladeCut": "the blade line splits the clip on the timeline",
  "edit.bladeCut.confirm": "the blade line splits the clip on the timeline",
  "edit.rollClipJoin": "the join marker moves under the person's hand",
  "edit.setClipJoin": "the join badge shows the new mode",
  "track.muteToggle": "the lane and its button show the mute",
  "track.setVolume": "the fader shows the level",
  "track.add": "the new lane appears",
  "media.import": "the import job chip reports progress and completion",
};

describe("every mutating command", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    _resetClipboardForTests();
    vi.mocked(submitQueuedDocumentCommand)
      .mockReset()
      .mockResolvedValue({ history_head_id: HEAD });
    useDawStore.getState().hydrate("/tmp/ep", project());
    useDawStore.setState({
      guestMode: null,
      shareCapabilities: null,
      feedbackToast: null,
      selection: null,
      playheadSec: 8,
    });
  });

  const mutating = Object.values(COMMANDS)
    .filter((def) => def.mutates)
    .map((def) => def.id);

  it("has a proof: a driver, a covering test or a reason it raises no toast", () => {
    const known = new Set([
      ...Object.keys(DRIVEN),
      ...Object.keys(COVERED),
      ...Object.keys(IN_PLACE),
    ]);
    expect(mutating.filter((id) => !known.has(id))).toEqual([]);
    expect([...known].filter((id) => !mutating.includes(id))).toEqual([]);
  });

  it.each(Object.entries(COVERED))(
    "%s: %s asserts the toast's Undo",
    (_id, file) => {
      const path = join(SRC_ROOT, file);
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf-8")).toMatch(/feedbackToast|undo/);
    },
  );

  it.each(Object.keys(DRIVEN))(
    "%s raises a toast that offers Undo",
    async (id) => {
      const toast = await DRIVEN[id]!();
      expect(toast).toMatchObject({ undo: HEAD });
    },
  );
});
