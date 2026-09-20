import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { matchKeymapCommands } from "../keymap/registry";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { buildCommandContext, evaluateWhen } from "./context";
import { clearRegisteredCommands, execute } from "./execute";
import {
  _resetTrackMutateChainForTests,
  registerDawCommands,
} from "./register";

vi.mock("../api", () => ({
  removeTrackCommand: vi.fn(async () => undefined),
  refreshProject: vi.fn(async () =>
    minimalProject({
      tracks: [],
      timeline_duration_sec: 20,
    }),
  ),
  deleteClips: vi.fn(async () => undefined),
  rippleDeleteClips: vi.fn(async () => undefined),
  pasteSegment: vi.fn(),
  rippleDeleteRange: vi.fn(),
  duplicateSegment: vi.fn(),
  undoHistory: vi.fn(),
  redoHistory: vi.fn(),
  splitAtTime: vi.fn(),
  startRenderPreview: vi.fn(),
  waitForPipelineJob: vi.fn(),
}));

function keyEvent(
  partial: Partial<
    Pick<
      KeyboardEvent,
      "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
    >
  >,
) {
  return {
    key: "a",
    code: "KeyA",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...partial,
  };
}

function sampleProject() {
  return minimalProject({
    timeline_duration_sec: 42,
    tracks: [
      {
        id: "host",
        label: "Host",
        role: "dialogue",
        speaker: "A",
        gain_db: 0,
        muted: false,
        duration_sec: 20,
        fx_count: 0,
        stem_is_fresh: true,
      },
      {
        id: "guest",
        label: "Guest",
        role: "dialogue",
        speaker: "B",
        gain_db: 0,
        muted: false,
        duration_sec: 20,
        fx_count: 0,
        stem_is_fresh: true,
      },
    ],
    clips: {
      tracks: {
        host: [
          {
            id: "c1",
            track_id: "host",
            source_start: 0,
            source_end: 5,
            timeline_start: 0,
            timeline_end: 5,
            fade_in_ms: 0,
            fade_out_ms: 0,
            join_in_mode: "fade",
            source_id: null,
          },
        ],
      },
      clip_count: 1,
    },
  });
}

/** First keymap match whose catalog when-clause passes (listener fall-through). */
function firstEnabledKeymapId(
  e: ReturnType<typeof keyEvent>,
): string | undefined {
  const ctx = buildCommandContext();
  for (const cmd of matchKeymapCommands(e)) {
    const gate = evaluateWhen(cmd.when, ctx);
    if (gate.ok) {
      return cmd.id;
    }
  }
  return undefined;
}

describe("track.remove / nav / Escape fall-through", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    _resetTrackMutateChainForTests();
    vi.mocked(api.removeTrackCommand).mockClear();
    vi.mocked(api.refreshProject).mockClear();
    vi.mocked(api.deleteClips).mockClear();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    useDawStore.setState({
      projectPath: "/tmp/ep",
      guestMode: null,
      shareCapabilities: null,
      project: sampleProject(),
      selection: null,
      selectedTrackIds: ["host", "guest"],
      playheadSec: 12,
      commentMode: false,
      timelineFocused: true,
    });
  });

  it("removes inspector track after confirm and clears selection", async () => {
    useDawStore.setState({
      selection: { kind: "track", trackId: "host" },
    });
    expect((await execute("track.remove")).status).toBe("ok");
    expect(api.removeTrackCommand).toHaveBeenCalledWith("/tmp/ep", "host");
    expect(useDawStore.getState().selection).toBeNull();
    expect(useDawStore.getState().selectedTrackIds).toEqual(["guest"]);
  });

  it("does not remove from Mod+A targeting alone", async () => {
    useDawStore.setState({
      selection: null,
      selectedTrackIds: ["host", "guest"],
    });
    const r = await execute("track.remove");
    expect(r.status).toBe("disabled");
    expect(api.removeTrackCommand).not.toHaveBeenCalled();
  });

  it("cancels remove when confirm is false", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    useDawStore.setState({
      selection: { kind: "track", trackId: "host" },
    });
    expect((await execute("track.remove", {}, { skipWhen: true })).status).toBe(
      "disabled",
    );
    expect(api.removeTrackCommand).not.toHaveBeenCalled();
  });

  it("Backspace prefers track.remove over edit.delete when track selected", () => {
    useDawStore.setState({
      selection: { kind: "track", trackId: "host" },
    });
    expect(
      firstEnabledKeymapId(keyEvent({ key: "Backspace", code: "Backspace" })),
    ).toBe("track.remove");
  });

  it("Backspace falls through to edit.delete when clip selected", () => {
    useDawStore.setState({
      selection: { kind: "clip", id: "c1", trackId: "host" },
    });
    expect(
      firstEnabledKeymapId(keyEvent({ key: "Backspace", code: "Backspace" })),
    ).toBe("edit.delete");
  });

  it("Escape exits comment mode before clear selection", () => {
    useDawStore.setState({
      commentMode: true,
      selection: { kind: "track", trackId: "host" },
    });
    expect(
      firstEnabledKeymapId(keyEvent({ key: "Escape", code: "Escape" })),
    ).toBe("review.exitCommentMode");
  });

  it("Escape clears inspector selection when not in comment mode", async () => {
    useDawStore.setState({
      commentMode: false,
      selection: { kind: "clip", id: "c1", trackId: "host" },
      selectedTrackIds: ["host"],
    });
    expect(
      firstEnabledKeymapId(keyEvent({ key: "Escape", code: "Escape" })),
    ).toBe("edit.clearSelection");
    expect((await execute("edit.clearSelection")).status).toBe("ok");
    expect(useDawStore.getState().selection).toBeNull();
    expect(useDawStore.getState().selectedTrackIds).toEqual(["host"]);
  });

  it("Home / End and Mod+arrows seek session bounds", async () => {
    useDawStore.setState({ playheadSec: 12 });
    expect((await execute("navigation.goToStart")).status).toBe("ok");
    expect(useDawStore.getState().playheadSec).toBe(0);
    expect((await execute("navigation.goToEnd")).status).toBe("ok");
    expect(useDawStore.getState().playheadSec).toBe(42);

    expect(
      matchKeymapCommands(keyEvent({ key: "Home", code: "Home" })).map(
        (c) => c.id,
      ),
    ).toContain("navigation.goToStart");
    expect(
      matchKeymapCommands(
        keyEvent({ key: "ArrowLeft", code: "ArrowLeft", metaKey: true }),
      ).map((c) => c.id),
    ).toContain("navigation.goToStart");
    expect(
      matchKeymapCommands(
        keyEvent({ key: "ArrowRight", code: "ArrowRight", metaKey: true }),
      ).map((c) => c.id),
    ).toContain("navigation.goToEnd");
  });
});
