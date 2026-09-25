import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import { useDawStore } from "../state/dawStore";
import { deferred } from "../test/deferred";
import { minimalProject, sampleTrack } from "../test/fixtures";
import type { TrackView } from "../types/project";
import { clearRegisteredCommands, execute } from "./execute";
import {
  _resetMixLanesForTests,
  flushPendingMix,
  registerTrackMixCommands,
  SAVED_MUTE_READ_ONLY,
  VOLUME_SAVE_DELAY_MS,
} from "./trackMix";

vi.mock("../api", () => ({
  setTrackFaderCommand: vi.fn(async () => ({})),
  setTrackMuteCommand: vi.fn(async () => ({})),
}));

function hostTrack(): TrackView | undefined {
  return useDawStore.getState().project?.tracks.find((t) => t.id === "host");
}

/** Sends that wait for the test to settle them, in call order. */
function heldSend() {
  const held: Array<ReturnType<typeof deferred<Record<string, unknown>>>> = [];
  const impl = () => {
    const pending = deferred<Record<string, unknown>>();
    held.push(pending);
    return pending.promise;
  };
  return { held, impl };
}

describe("track mix commands (#386)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearRegisteredCommands();
    registerTrackMixCommands();
    vi.mocked(api.setTrackFaderCommand).mockReset();
    vi.mocked(api.setTrackFaderCommand).mockResolvedValue({});
    vi.mocked(api.setTrackMuteCommand).mockReset();
    vi.mocked(api.setTrackMuteCommand).mockResolvedValue({});
    useDawStore.setState({
      projectPath: "/tmp/ep",
      guestMode: null,
      shareCapabilities: null,
      project: minimalProject({
        tracks: [sampleTrack({ id: "host", gain_db: -2 })],
      }),
      selection: { kind: "track", trackId: "host" },
      selectedTrackIds: [],
      viewerMute: {},
      statusAnnouncement: "",
    });
  });

  afterEach(async () => {
    await vi.runAllTimersAsync();
    _resetMixLanesForTests();
    vi.useRealTimers();
  });

  /** Replace the host track as a server snapshot would. */
  function serverSends(fields: Partial<TrackView>): void {
    const project = useDawStore.getState().project;
    if (project) {
      useDawStore.getState().setProject({
        ...project,
        tracks: [{ ...project.tracks[0], ...fields }],
      });
    }
  }

  it("shows each volume step at once and saves only the last", async () => {
    const steps = [-3, -3.5, 40].map((db) =>
      execute("track.setVolume", { db }),
    );
    expect(hostTrack()?.fader_db).toBe(12);
    expect(api.setTrackFaderCommand).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(VOLUME_SAVE_DELAY_MS);
    expect(api.setTrackFaderCommand).toHaveBeenCalledTimes(1);
    expect(api.setTrackFaderCommand).toHaveBeenCalledWith(
      "/tmp/ep",
      "host",
      12,
    );
    for (const result of await Promise.all(steps)) {
      expect(result.status).toBe("ok");
    }
  });

  it("keeps one mute in flight and sends the newest after it", async () => {
    const { held, impl } = heldSend();
    vi.mocked(api.setTrackMuteCommand).mockImplementation(impl);
    const first = execute("track.muteToggle");
    await vi.waitFor(() => expect(held).toHaveLength(1));
    const second = execute("track.muteToggle");
    expect(hostTrack()?.muted).toBe(false);
    expect(api.setTrackMuteCommand).toHaveBeenCalledTimes(1);

    held[0].resolve({});
    await vi.waitFor(() => expect(held).toHaveLength(2));
    held[1].resolve({});
    await Promise.all([first, second]);
    expect(vi.mocked(api.setTrackMuteCommand).mock.calls).toEqual([
      ["/tmp/ep", "host", true],
      ["/tmp/ep", "host", false],
    ]);
  });

  it("keeps showing a newer value when an older reply lands", async () => {
    const { held, impl } = heldSend();
    vi.mocked(api.setTrackMuteCommand).mockImplementation(async (...args) => {
      const reply = impl();
      // The server's reply carries the value it saved.
      const project = useDawStore.getState().project;
      await reply;
      if (project) {
        useDawStore.getState().setProject({
          ...project,
          tracks: [{ ...project.tracks[0], muted: args[2] }],
        });
      }
      return {};
    });
    void execute("track.muteToggle");
    await vi.waitFor(() => expect(held).toHaveLength(1));
    void execute("track.muteToggle");
    held[0].resolve({});
    await vi.waitFor(() => expect(held).toHaveLength(2));
    expect(hostTrack()?.muted).toBe(false);
    held[1].resolve({});
  });

  it("reverts only the failed field to its saved value", async () => {
    vi.mocked(api.setTrackFaderCommand).mockRejectedValue(new Error("nope"));
    const pending = execute("track.setVolume", { db: -6 });
    await execute("track.muteToggle");
    await vi.advanceTimersByTimeAsync(VOLUME_SAVE_DELAY_MS);
    const result = await pending;
    expect(result.status).toBe("disabled");
    expect(hostTrack()).toMatchObject({ fader_db: 0, muted: true });
    expect(useDawStore.getState().statusAnnouncement).toContain("nope");
  });

  it("doesn't revert a failed step that a newer one replaced", async () => {
    const { held, impl } = heldSend();
    vi.mocked(api.setTrackFaderCommand).mockImplementation(impl);
    void execute("track.setVolume", { db: -3 });
    await vi.advanceTimersByTimeAsync(VOLUME_SAVE_DELAY_MS);
    expect(held).toHaveLength(1);
    void execute("track.setVolume", { db: -6 });
    await vi.advanceTimersByTimeAsync(VOLUME_SAVE_DELAY_MS);
    held[0].reject(new Error("rate limited"));
    await vi.waitFor(() => expect(held).toHaveLength(2));
    expect(hostTrack()?.fader_db).toBe(-6);
    held[1].resolve({});
  });

  it("keeps an unsaved value shown over another reply", async () => {
    const pending = execute("track.setVolume", { db: -6 });
    serverSends({ fader_db: 0 });
    expect(hostTrack()?.fader_db).toBe(-6);
    await vi.advanceTimersByTimeAsync(VOLUME_SAVE_DELAY_MS);
    await pending;
    serverSends({ fader_db: 0 });
    expect(hostTrack()?.fader_db).toBe(0);
  });

  it("keeps a value the host queued shown until it's sent", async () => {
    vi.mocked(api.setTrackMuteCommand).mockResolvedValue({ queued: true });
    await execute("track.muteToggle");
    serverSends({ muted: false });
    expect(hostTrack()?.muted).toBe(true);
    await vi.advanceTimersByTimeAsync(15_001);
    serverSends({ muted: false });
    expect(hostTrack()?.muted).toBe(false);
  });

  it("marks the premix behind as soon as the mix changes", async () => {
    const project = useDawStore.getState().project;
    if (project) {
      useDawStore.getState().setProject({
        ...project,
        render_status: {
          ...project.render_status,
          premix: { exists: true, stale_vs_mix: false },
        },
      });
    }
    void execute("track.setVolume", { db: -6 });
    expect(
      useDawStore.getState().project?.render_status.premix.stale_vs_mix,
    ).toBe(true);
  });

  it("sends a waiting volume at once when flushed, before an undo", async () => {
    const pending = execute("track.setVolume", { db: -6 });
    const flushed = flushPendingMix();
    await flushed;
    expect(api.setTrackFaderCommand).toHaveBeenCalledWith(
      "/tmp/ep",
      "host",
      -6,
    );
    expect((await pending).status).toBe("ok");
  });

  it("saves nothing when a burst ends where it began", async () => {
    void execute("track.setVolume", { db: -3 });
    void execute("track.setVolume", { db: 0 });
    await vi.advanceTimersByTimeAsync(VOLUME_SAVE_DELAY_MS);
    expect(api.setTrackFaderCommand).not.toHaveBeenCalled();
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
    const volume = execute("track.setVolume", { db: 1.5 });
    await vi.advanceTimersByTimeAsync(VOLUME_SAVE_DELAY_MS);
    expect((await volume).status).toBe("ok");
    expect((await execute("track.muteToggle")).status).toBe("ok");
    expect(api.setTrackMuteCommand).toHaveBeenCalledWith(
      "share:tok",
      "host",
      true,
    );
    expect(hostTrack()).toMatchObject({ fader_db: 1.5, muted: true });
  });

  it("clears a leftover listen-only mute and unmutes in one press", async () => {
    useDawStore.setState({
      viewerMute: { host: true },
      project: minimalProject({
        tracks: [sampleTrack({ id: "host", muted: true })],
      }),
    });
    expect((await execute("track.muteToggle")).status).toBe("ok");
    expect(useDawStore.getState().viewerMute.host).toBe(false);
    expect(api.setTrackMuteCommand).toHaveBeenCalledWith(
      "/tmp/ep",
      "host",
      false,
    );
  });

  it("clears an editor's leftover listen-only mute before the saved one", async () => {
    useDawStore.setState({ viewerMute: { host: true } });
    expect((await execute("track.muteToggle")).status).toBe("ok");
    expect(useDawStore.getState().viewerMute.host).toBe(false);
    expect(api.setTrackMuteCommand).not.toHaveBeenCalled();
    expect(hostTrack()?.muted).toBe(false);
  });

  it("tells a guest why they can't unmute a saved mute", async () => {
    useDawStore.setState({
      projectPath: "share:tok",
      shareCapabilities: ["view"],
      project: minimalProject({
        tracks: [sampleTrack({ id: "host", muted: true })],
      }),
    });
    const result = await execute("track.muteToggle");
    expect(result).toEqual({
      status: "disabled",
      reason: SAVED_MUTE_READ_ONLY,
    });
    expect(useDawStore.getState().statusAnnouncement).toBe(
      SAVED_MUTE_READ_ONLY,
    );
    expect(useDawStore.getState().viewerMute.host).toBeFalsy();
  });

  it("rejects a volume that isn't a number", async () => {
    const result = await execute("track.setVolume", { db: "loud" });
    expect(result.status).toBe("disabled");
    expect(api.setTrackFaderCommand).not.toHaveBeenCalled();
  });
});
