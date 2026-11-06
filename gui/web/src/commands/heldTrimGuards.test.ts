import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDocumentSeqForTests } from "../document/cursor";
import { getClipboard, setClipboard } from "../edit/clipboard";
import { TRIM_MODE } from "../edit/clipEdgeSave";
import { submitQueuedDocumentCommand } from "../services/commandQueue";
import { useDawStore } from "../state/dawStore";
import { clipRow, sampleTrack } from "../test/fixtures";
import { initializeCommentProject } from "../test/trimNudgeData";
import {
  registerClipboardCommands,
  registerClipMoveCommands,
  registerPrimaryEditingCommands,
} from "./editing";
import { registerEditVerbCommands } from "./editVerbs";
import { clearRegisteredCommands, execute } from "./execute";
import { _resetMixLanesForTests, registerTrackMixCommands } from "./trackMix";
import { _resetTrackMutateChainForTests } from "./trackMutation";

vi.mock("../services/commandQueue", () => ({
  submitQueuedDocumentCommand: vi.fn(async () => ({})),
}));

// Command-layer guards for a held trim. A held trim (pointer or keyboard
// handle) lays a ripple preview over the project; commands that read the
// project must not act on the preview-only pieces (`<id>:tail`) and must read
// clean clip geometry.
const target = {
  trackId: "host",
  clipId: "anchor",
  edge: "out",
  mode: TRIM_MODE,
} as const;

function hold(sourceSec = 9.99) {
  const token = Symbol("hold");
  const store = useDawStore.getState();
  expect(store.changeHeldTrim({ kind: "begin", token, target }).kind).toBe(
    "accepted",
  );
  expect(store.changeHeldTrim({ kind: "value", token, sourceSec }).kind).toBe(
    "accepted",
  );
  return token;
}

function withSplitTail() {
  const { origin } = initializeCommentProject();
  origin.tracks.push(sampleTrack({ id: "guest" }));
  origin.clips.tracks.guest = [
    clipRow({
      id: "wide",
      track_id: "guest",
      source_start: 20,
      source_end: 24,
      timeline_start: 8,
      timeline_end: 12,
    }),
  ];
  hold();
  const hasTail = useDawStore
    .getState()
    .project?.clips.tracks.guest.some((clip) => clip.id === "wide:tail");
  expect(hasTail).toBe(true);
}

describe("commands during a held trim", () => {
  beforeEach(() => {
    resetDocumentSeqForTests();
    vi.mocked(submitQueuedDocumentCommand).mockReset().mockResolvedValue({});
    clearRegisteredCommands();
    _resetTrackMutateChainForTests();
  });
  afterEach(() => _resetMixLanesForTests());

  it("rejects a preview-only tail move before submission", async () => {
    withSplitTail();
    registerClipMoveCommands();
    const result = await execute(
      "edit.moveClips",
      {
        clips: [
          { clip_id: "wide:tail", track_id: "guest", timeline_start: 18 },
        ],
      },
      { skipWhen: true },
    );
    expect(result.status).toBe("disabled");
    expect(submitQueuedDocumentCommand).not.toHaveBeenCalled();
  });

  it.each(["edit.copy", "edit.cut", "edit.delete", "edit.rippleDelete"])(
    "%s rejects a preview-only split target without sending or copying it",
    async (command) => {
      withSplitTail();
      useDawStore
        .getState()
        .setSelection({ kind: "clip", trackId: "guest", id: "wide:tail" });
      setClipboard(null);
      registerClipboardCommands();
      registerPrimaryEditingCommands();
      registerEditVerbCommands();
      const result = await execute(command, {}, { skipWhen: true });
      expect(result.status).toBe("disabled");
      expect(submitQueuedDocumentCommand).not.toHaveBeenCalled();
      expect(getClipboard()).toBeNull();
    },
  );

  it("copy uses the clean original clip duration during a held trim", async () => {
    initializeCommentProject();
    hold();
    useDawStore
      .getState()
      .setSelection({ kind: "clip", trackId: "host", id: "anchor" });
    registerClipboardCommands();
    expect((await execute("edit.copy", {}, { skipWhen: true })).status).toBe(
      "ok",
    );
    expect(getClipboard()?.timelineEnd).toBe(10);
  });

  it("an unchanged pending mix permits trim steps and keeps its preview", async () => {
    vi.useFakeTimers();
    try {
      initializeCommentProject();
      registerTrackMixCommands();
      const mix = execute(
        "track.setVolume",
        { trackId: "host", db: -3 },
        { skipWhen: true },
      );
      const token = hold(9.99);
      const store = useDawStore.getState();
      expect(
        store.changeHeldTrim({ kind: "value", token, sourceSec: 9.98 }).kind,
      ).toBe("accepted");
      const shown = useDawStore.getState().project;
      expect(shown?.clips.tracks.host[0]?.source_end).toBe(9.98);
      expect(shown?.tracks[0]?.fader_db).toBe(-3);
      store.changeHeldTrim({ kind: "finish", token, disposition: "discard" });
      await vi.advanceTimersByTimeAsync(300);
      await mix;
    } finally {
      vi.useRealTimers();
    }
  });
});
