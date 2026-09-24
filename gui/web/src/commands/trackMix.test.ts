import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { resetDocumentSeqForTests } from "../document/cursor";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import type { TrackView } from "../types/project";
import { clearRegisteredCommands, execute } from "./execute";
import { registerTrackMixCommands } from "./trackMix";

vi.mock("../api", () => ({
  setTrackFaderCommand: vi.fn(async () => ({})),
  setTrackMuteCommand: vi.fn(async () => ({})),
}));

const host: TrackView = {
  id: "host",
  label: "Host",
  role: "dialogue",
  speaker: "A",
  gain_db: -2,
  fader_db: 0,
  muted: false,
  duration_sec: 20,
  fx_count: 0,
  stem_is_fresh: true,
};

function hostTrack(): TrackView | undefined {
  return useDawStore.getState().project?.tracks.find((t) => t.id === "host");
}

describe("track mix commands (#386)", () => {
  beforeEach(() => {
    clearRegisteredCommands();
    registerTrackMixCommands();
    resetDocumentSeqForTests();
    vi.mocked(api.setTrackFaderCommand).mockReset();
    vi.mocked(api.setTrackFaderCommand).mockResolvedValue({});
    vi.mocked(api.setTrackMuteCommand).mockReset();
    vi.mocked(api.setTrackMuteCommand).mockResolvedValue({});
    useDawStore.setState({
      projectPath: "/tmp/ep",
      guestMode: null,
      shareCapabilities: null,
      project: minimalProject({ tracks: [host] }),
      selection: { kind: "track", trackId: "host" },
      selectedTrackIds: [],
      viewerMute: {},
    });
  });

  it("saves a rounded, clamped volume and splices it in before the reply", async () => {
    let release: () => void = () => undefined;
    vi.mocked(api.setTrackFaderCommand).mockImplementation(
      () => new Promise((resolve) => (release = () => resolve({}))),
    );
    const pending = execute("track.setVolume", { db: -3.456 });
    await vi.waitFor(() => {
      expect(api.setTrackFaderCommand).toHaveBeenCalled();
    });
    expect(hostTrack()?.fader_db).toBe(-3.46);
    release();
    expect((await pending).status).toBe("ok");
    expect(api.setTrackFaderCommand).toHaveBeenCalledWith(
      "/tmp/ep",
      "host",
      -3.46,
    );

    vi.mocked(api.setTrackFaderCommand).mockResolvedValue({});
    await execute("track.setVolume", { trackId: "host", db: 40 });
    expect(api.setTrackFaderCommand).toHaveBeenLastCalledWith(
      "/tmp/ep",
      "host",
      12,
    );
  });

  it("reverts the volume when the server refuses it", async () => {
    vi.mocked(api.setTrackFaderCommand).mockRejectedValue(new Error("nope"));
    const result = await execute("track.setVolume", { db: -6 });
    expect(result.status).toBe("disabled");
    expect(hostTrack()?.fader_db).toBe(0);
    expect(useDawStore.getState().statusAnnouncement).toContain("nope");
  });

  it("refuses volume changes from guests without edit", async () => {
    useDawStore.setState({
      projectPath: "share:tok",
      shareCapabilities: ["view", "suggest"],
    });
    const result = await execute("track.setVolume", { db: -6 });
    expect(result.status).toBe("disabled");
    expect(api.setTrackFaderCommand).not.toHaveBeenCalled();
    expect(hostTrack()?.fader_db).toBe(0);
  });

  it("lets edit guests save volume and mute", async () => {
    useDawStore.setState({
      projectPath: "share:tok",
      shareCapabilities: ["view", "edit"],
    });
    expect((await execute("track.setVolume", { db: 1.5 })).status).toBe("ok");
    expect((await execute("track.muteToggle")).status).toBe("ok");
    expect(api.setTrackMuteCommand).toHaveBeenCalledWith(
      "share:tok",
      "host",
      true,
    );
    expect(hostTrack()).toMatchObject({ fader_db: 1.5, muted: true });
  });

  it("rejects a volume that isn't a number", async () => {
    const result = await execute("track.setVolume", { db: "loud" });
    expect(result.status).toBe("disabled");
    expect(api.setTrackFaderCommand).not.toHaveBeenCalled();
  });
});
