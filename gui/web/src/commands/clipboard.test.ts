import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { _resetClipboardForTests, getClipboard } from "../edit/clipboard";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { clearRegisteredCommands, execute } from "./execute";
import { registerDawCommands } from "./register";

vi.mock("../api", () => ({
  pasteSegment: vi.fn(async () => undefined),
  rippleDeleteRange: vi.fn(async () => undefined),
  rippleDeleteClips: vi.fn(async () => undefined),
  deleteClips: vi.fn(async () => undefined),
  refreshProject: vi.fn(async () =>
    minimalProject({
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
    }),
  ),
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
    vi.mocked(api.rippleDeleteRange).mockClear();
    vi.mocked(api.rippleDeleteClips).mockClear();
    vi.mocked(api.refreshProject).mockClear();
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
});

describe("phase-2 P0 edit/view/track commands", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerDawCommands();
    vi.mocked(api.deleteClips).mockClear();
    vi.mocked(api.rippleDeleteClips).mockClear();
    vi.mocked(api.refreshProject).mockClear();
    useDawStore.setState({
      projectPath: "/tmp/ep",
      guestMode: null,
      project: sampleProject(),
      selection: { kind: "clip", id: "c1", trackId: "host" },
      selectedTrackIds: ["host"],
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
      selectedTrackIds: ["host"],
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
