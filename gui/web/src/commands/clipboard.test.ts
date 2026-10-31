import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import {
  _resetClipboardForTests,
  getClipboard,
  setClipboard,
} from "../edit/clipboard";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { wordSelection } from "../utils/rangeSelect";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";

vi.mock("../api", () => ({
  pasteSegment: vi.fn(async () => undefined),
  rippleDeleteClips: vi.fn(async () => ({ queued: false, asked: false })),
  deleteClips: vi.fn(async () => undefined),
  duplicateSegment: vi.fn(async () => undefined),
  setTrackMuteCommand: vi.fn(async () => ({})),
  undoHistory: vi.fn(),
  redoHistory: vi.fn(),
  splitAtTime: vi.fn(),
  startRenderPreview: vi.fn(),
  waitForPipelineJob: vi.fn(),
}));

function sampleProject() {
  return minimalProject({
    timeline_duration_sec: 20,
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
            source_duration_sec: null,
            recording_key: null,
          },
        ],
      },
      clip_count: 1,
    },
  });
}

describe("edit.copy/cut/paste", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    _resetClipboardForTests();
    vi.mocked(api.pasteSegment).mockClear();
    vi.mocked(api.rippleDeleteClips).mockClear();
    vi.mocked(api.duplicateSegment).mockClear();
    useDawStore.setState({
      projectPath: "/tmp/ep",
      guestMode: null,
      project: sampleProject(),
      selection: { kind: "clip", id: "c1", trackId: "host" },
      playheadSec: 8,
    });
  });

  it("copies selection to session clipboard", async () => {
    const r = await execute("edit.copy");
    expect(r.status).toBe("ok");
    expect(getClipboard()?.mode).toBe("copy");
    expect(getClipboard()?.extracts.length).toBe(1);
  });

  it("cuts then pastes via PasteSegment extracts", async () => {
    expect((await execute("edit.cut")).status).toBe("ok");
    expect(api.rippleDeleteClips).toHaveBeenCalled();
    expect(getClipboard()?.mode).toBe("cut");
    expect((await execute("edit.paste")).status).toBe("ok");
    expect(api.pasteSegment).toHaveBeenCalled();
    expect(api.duplicateSegment).not.toHaveBeenCalled();
  });

  it("pastes at the playhead without a time and at atTime with one", async () => {
    expect((await execute("edit.cut")).status).toBe("ok");
    expect((await execute("edit.paste")).status).toBe("ok");
    expect(vi.mocked(api.pasteSegment).mock.calls[0]?.[1]).toBe(8);
    expect((await execute("edit.paste", { atTime: 12.5 })).status).toBe("ok");
    expect(vi.mocked(api.pasteSegment).mock.calls[1]?.[1]).toBe(12.5);
    expect(useDawStore.getState().statusAnnouncement).toContain("00:12.500");
  });

  it("duplicates a copied range at atTime", async () => {
    setClipboard({
      timelineStart: 0,
      timelineEnd: 5,
      mode: "copy",
      extracts: [],
    });
    expect((await execute("edit.paste", { atTime: 3 })).status).toBe("ok");
    expect(api.duplicateSegment).toHaveBeenCalledWith("/tmp/ep", 0, 5, 3);
  });

  it("refuses a paste time that is not a number, changing nothing", async () => {
    expect((await execute("edit.cut")).status).toBe("ok");
    expect(await execute("edit.paste", { atTime: "soon" })).toEqual({
      status: "disabled",
      reason: "atTime must be a number",
    });
    expect(api.pasteSegment).not.toHaveBeenCalled();
  });

  it("refuses a media cut of a tapped word in Correct mode", async () => {
    useDawStore.setState({
      selection: wordSelection({
        trackId: "host",
        sourceId: null,
        wordIndex: 0,
      }),
      transcriptCorrecting: true,
    });
    expect(await execute("edit.cut")).toMatchObject({
      status: "disabled",
      reason: "Use Select mode for media cut (Correct is ASR-only)",
    });
    expect(api.rippleDeleteClips).not.toHaveBeenCalled();
  });

  it("refuses every range action on a tapped word in Correct mode, each for the Correct reason", async () => {
    useDawStore.setState({
      selection: wordSelection({
        trackId: "host",
        sourceId: null,
        wordIndex: 0,
      }),
      transcriptCorrecting: true,
    });
    const cut = "Use Select mode for media cut (Correct is ASR-only)";
    const other = "Use Select mode for range actions (Correct is ASR-only)";
    for (const [id, reason] of [
      ["range.cut", cut],
      ["range.mute", other],
      ["range.play", other],
      ["range.comment", other],
      ["range.bounce", other],
    ] as const) {
      expect(await execute(id)).toEqual({ status: "disabled", reason });
    }
    expect(api.rippleDeleteClips).not.toHaveBeenCalled();
  });

  it("does not cut a different clip after a selection-sheet action goes stale", async () => {
    expect((await execute("edit.cut", { clipId: "another" })).status).toBe(
      "disabled",
    );
    expect(api.rippleDeleteClips).not.toHaveBeenCalled();
    expect(getClipboard()).toBeNull();
  });
});

describe("phase-2 P0 edit/view/track commands", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    vi.mocked(api.deleteClips).mockClear();
    vi.mocked(api.rippleDeleteClips).mockClear();
    useDawStore.setState({
      projectPath: "/tmp/ep",
      guestMode: null,
      project: sampleProject(),
      selection: { kind: "clip", id: "c1", trackId: "host" },
      playheadSec: 8,
      zoomPxPerSec: 40,
      viewerMute: {},
      soloTracks: {},
    });
  });

  it("deletes and ripple-deletes the selected clip", async () => {
    expect((await execute("edit.delete")).status).toBe("ok");
    expect(api.deleteClips).toHaveBeenCalledWith("/tmp/ep", ["c1"]);
    useDawStore.setState({
      selection: { kind: "clip", id: "c1", trackId: "host" },
    });
    expect((await execute("edit.rippleDelete")).status).toBe("ok");
    expect(api.rippleDeleteClips).toHaveBeenCalledWith("/tmp/ep", ["c1"]);
  });

  it("saves the host's mute and keeps solo listen-only", async () => {
    vi.mocked(api.setTrackMuteCommand).mockClear();
    expect((await execute("track.muteToggle")).status).toBe("ok");
    expect(api.setTrackMuteCommand).toHaveBeenCalledWith(
      "/tmp/ep",
      "host",
      true,
    );
    const host = useDawStore
      .getState()
      .project?.tracks.find((t) => t.id === "host");
    expect(host?.muted).toBe(true);
    expect(useDawStore.getState().viewerMute.host).toBeUndefined();
    expect((await execute("track.soloToggle")).status).toBe("ok");
    expect(useDawStore.getState().soloTracks.host).toBe(true);
  });

  it("gives a view-only guest a listen-only mute", async () => {
    vi.mocked(api.setTrackMuteCommand).mockClear();
    useDawStore.setState({
      projectPath: "share:tok",
      shareCapabilities: ["view"],
      selection: { kind: "clip", id: "c2", trackId: "guest" },
      viewerMute: {},
    });
    expect((await execute("track.muteToggle")).status).toBe("ok");
    expect(useDawStore.getState().viewerMute.guest).toBe(true);
    expect(useDawStore.getState().viewerMute.host).toBeUndefined();
    expect(api.setTrackMuteCommand).not.toHaveBeenCalled();
  });

  it("zooms in/out and fits", async () => {
    const before = useDawStore.getState().zoomPxPerSec;
    expect((await execute("view.zoomIn")).status).toBe("ok");
    expect(useDawStore.getState().zoomPxPerSec).toBeGreaterThan(before);
    expect((await execute("view.zoomOut")).status).toBe("ok");
    expect((await execute("view.fit")).status).toBe("ok");
  });
});
