import { readFileSync } from "node:fs";
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

const selectTrack = (trackId: string) =>
  useDawStore.getState().setSelection({ kind: "track", trackId });

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

async function fillRoomToneToast() {
  const state = useDawStore.getState();
  const base = state.project!;
  const withGap = {
    ...base,
    clips: {
      ...base.clips,
      tracks: {
        ...base.clips.tracks,
        host: [
          ...base.clips.tracks.host!,
          clipRow({
            id: "c2",
            track_id: "host",
            source_id: null,
            source_start: 5,
            source_end: 8,
            timeline_start: 8,
            timeline_end: 11,
          }),
        ],
      },
    },
  };
  const target = makeRangeTarget(withGap, [{ start: 4, end: 9 }], ["host"])!;
  useDawStore.setState({
    project: withGap,
    selection: { kind: "range", target },
  });
  vi.mocked(submitQueuedDocumentCommand).mockResolvedValue({
    type: "Applied",
    history_head_id: HEAD,
  });
  return toastOf("range.fillRoomTone");
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
  "track.reorder": () =>
    toastOf("track.reorder", { trackId: "host", index: 1 }),
  "track.moveUp": async () => {
    selectTrack("guest");
    return toastOf("track.moveUp");
  },
  "track.moveDown": async () => {
    selectTrack("host");
    return toastOf("track.moveDown");
  },
  "edit.addChapter": () => toastOf("edit.addChapter", { atTime: 3 }),
  "envelope.addPoint": async () => {
    useDawStore.getState().setLayerVisible("showLevels", true);
    return toastOf("envelope.addPoint", { trackId: "host", atTime: 2 });
  },
  "range.cut": () => rangeToast("cut"),
  "range.mute": () => rangeToast("mute"),
  "range.fillRoomTone": fillRoomToneToast,
};

type Proof = { file: string; test: string; shows?: RegExp };

/** The toast comes from a gesture or panel; the named test must assert its Undo. */
const COVERED: Record<string, Proof> = {
  "edit.restoreClipBleed": {
    file: "commands/clipBleed.test.ts",
    test: "sends the selected opaque target unchanged and offers exact acknowledged Undo",
  },
  "edit.trimClipEdge": {
    file: "timeline/useClipEdgeHandles.undo.test.tsx",
    test: "it.each([",
  },
  "edit.setClipFade": {
    file: "timeline/useClipEdgeHandles.undo.test.tsx",
    test: "it.each([",
  },
  "range.moveSpeakerLane": {
    file: "stage/edit/EditActionBar.test.tsx",
    test: "moves the selected range through the host API",
  },
  "track.remove": {
    file: "commands/trackRemoveNav.test.ts",
    test: "asks by the track's name, then offers Undo for the entry its reply names",
  },
  "track.splitSpeakers": {
    file: "stages/prepare/usePrepareSources.test.tsx",
    test: "splits with the chosen voice count, then refreshes and says it with Undo",
    shows: /undo: "h2"/,
  },
  "transcript.ignoreWords": {
    file: "commands/transcriptIgnore.test.ts",
    test: "offers Undo on the toast for the history entry the command left",
  },
  "comment.resolve": {
    file: "panels/CommentsPanel.test.tsx",
    test: "shows an Undo toast after resolving and reopens on Undo",
    shows: /name: "Undo"/,
  },
};

/** The test's own body: from its title to the next test. */
function testBody({ file, test }: Proof): string {
  const src = readFileSync(join(SRC_ROOT, file), "utf-8");
  const at = src.indexOf(test);
  if (at < 0) return "";
  const rest = src.slice(at + test.length);
  const next = rest.search(/\n {0,4}it(?:\.each)?\(/);
  return src.slice(at, at + test.length + (next < 0 ? rest.length : next));
}

/** The result shows where the person acted, so no toast is raised. */
const IN_PLACE: Record<string, string> = {
  "edit.bladeCut": "the blade line splits the clip on the timeline",
  "edit.split":
    "runs edit.bladeCut, which announces the split with Undo (editing.ts)",
  "edit.keep": "rejects the suggestion or opens History",
  "edit.mute":
    "runs range.mute, transcript.ignoreWords or track.muteToggle, each proven here",
  "edit.rollClipJoin": "the join marker moves under the person's hand",
  "edit.setClipJoin": "the join glyph shows the new mode",
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
    "%s: its named test asserts the toast's Undo",
    (_id, proof) => {
      const body = testBody(proof);
      expect(body, `${proof.file}: "${proof.test}"`).not.toBe("");
      expect(body).toMatch(proof.shows ?? /feedbackToast[\s\S]*?\bundo\b/);
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
