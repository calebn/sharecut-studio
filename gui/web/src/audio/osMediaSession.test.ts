import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDawStore } from "../state/dawStore";
import { clipRow, minimalProject, sampleTrack } from "../test/fixtures";
import {
  applyOsMediaSession,
  type MediaSessionLike,
  OS_SESSION_OFF,
  type OsTransportInput,
  osActionHandlers,
  osDiscontinuityKey,
  osTransportInput,
  projectOsMediaSession,
} from "./osMediaSession";

const PLAYING: OsTransportInput = {
  available: true,
  title: "Episode 12",
  durationSec: 600,
  isPlaying: true,
  preview: null,
  positionSec: 125,
  playbackRate: 1,
};

describe("projectOsMediaSession", () => {
  it("is off while nothing can play", () => {
    expect(projectOsMediaSession({ ...PLAYING, available: false })).toEqual({
      metadata: null,
      playbackState: "none",
      positionState: null,
      handlersOn: false,
    });
  });

  it("declares the title, state and position of a playing episode", () => {
    expect(projectOsMediaSession(PLAYING)).toEqual({
      metadata: { title: "Episode 12" },
      playbackState: "playing",
      positionState: { duration: 600, playbackRate: 1, position: 125 },
      handlersOn: true,
    });
  });

  it("declares a paused episode with its position", () => {
    expect(projectOsMediaSession({ ...PLAYING, isPlaying: false })).toEqual({
      metadata: { title: "Episode 12" },
      playbackState: "paused",
      positionState: { duration: 600, playbackRate: 1, position: 125 },
      handlersOn: true,
    });
  });

  it.each([
    [true, "playing"],
    [false, "paused"],
  ] as const)(
    "shows a source preview (playing %s) as %s with no episode position",
    (playing, playbackState) => {
      expect(
        projectOsMediaSession({
          ...PLAYING,
          isPlaying: !playing,
          preview: { playing },
        }),
      ).toEqual({
        metadata: { title: "Episode 12" },
        playbackState,
        positionState: null,
        handlersOn: true,
      });
    },
  );

  it.each([0, -3, Number.NaN, Number.POSITIVE_INFINITY])(
    "clears the position when the duration is %s",
    (durationSec) => {
      expect(
        projectOsMediaSession({ ...PLAYING, durationSec }).positionState,
      ).toBeNull();
    },
  );

  it.each([
    [700, 600],
    [-4, 0],
    [Number.NaN, 0],
  ])("clamps a paused position of %s to %s", (positionSec, position) => {
    expect(
      projectOsMediaSession({ ...PLAYING, isPlaying: false, positionSec })
        .positionState,
    ).toEqual({ duration: 600, playbackRate: 1, position });
  });

  it.each([600, 700])(
    "declares 0 when playing starts at %s s, where the engine wraps",
    (positionSec) => {
      expect(
        projectOsMediaSession({ ...PLAYING, positionSec }).positionState
          ?.position,
      ).toBe(0);
    },
  );

  it.each([
    [2, 2],
    [0.5, 0.5],
    [0, 1],
    [-1, 1],
    [Number.NaN, 1],
  ])("passes a rate of %s as %s", (rate, expected) => {
    expect(
      projectOsMediaSession({ ...PLAYING, playbackRate: rate }).positionState
        ?.playbackRate,
    ).toBe(expected);
  });

  it("falls back to an empty title while the project name is unknown", () => {
    expect(projectOsMediaSession({ ...PLAYING, title: null }).metadata).toEqual(
      { title: "" },
    );
  });

  it("never yields a position the Media Session spec rejects", () => {
    const strict = specSession();
    const durations = [-1, 0, 1, 59.5, 600, Number.NaN, Infinity];
    const positions = [-5, 0, 30, 600, 9999, Number.NaN, Infinity, -Infinity];
    const rates = [Number.NaN, -2, 0, 0.25, 1, 4, Infinity];
    for (const durationSec of durations)
      for (const positionSec of positions)
        for (const playbackRate of rates)
          for (const isPlaying of [true, false]) {
            const state = projectOsMediaSession({
              ...PLAYING,
              durationSec,
              positionSec,
              playbackRate,
              isPlaying,
            });
            expect(() =>
              applyOsMediaSession(
                strict.session,
                state,
                OS_SESSION_OFF,
                noHandlers,
                metadata,
              ),
            ).not.toThrow();
          }
  });
});

const noHandlers = {
  play: vi.fn(),
  pause: vi.fn(),
  seekbackward: vi.fn(),
  seekforward: vi.fn(),
  seekto: vi.fn(),
};
const metadata = (m: { title: string }) =>
  ({ title: m.title }) as MediaMetadata;

/** A Media Session that records every write in order and throws like the spec's setPositionState. */
function specSession() {
  const calls: string[] = [];
  const handlers = new Map<string, unknown>();
  const position: unknown[] = [];
  const session: MediaSessionLike = {
    set metadata(value: MediaMetadata | null) {
      calls.push(`metadata:${value?.title ?? "null"}`);
    },
    get metadata() {
      return null;
    },
    set playbackState(value: MediaSessionPlaybackState) {
      calls.push(`state:${value}`);
    },
    get playbackState() {
      return "none" as const;
    },
    setActionHandler(action, handler) {
      calls.push(`handler:${action}:${handler ? "fn" : "null"}`);
      handlers.set(action, handler);
    },
    setPositionState(state) {
      if (state === undefined) {
        calls.push("position:clear");
        return;
      }
      const { duration, position: at = 0, playbackRate = 1 } = state;
      if (
        duration === undefined ||
        !(duration >= 0) ||
        !Number.isFinite(duration) ||
        playbackRate === 0 ||
        !Number.isFinite(playbackRate) ||
        !(at >= 0 && at <= duration)
      )
        throw new TypeError("invalid position state");
      calls.push(`position:${at}/${duration}@${playbackRate}`);
      position.push(state);
    },
  };
  return { session, calls, handlers };
}

describe("applyOsMediaSession", () => {
  it("writes metadata, the handlers, the state, then the position", () => {
    const { session, calls } = specSession();
    applyOsMediaSession(
      session,
      projectOsMediaSession(PLAYING),
      OS_SESSION_OFF,
      noHandlers,
      metadata,
    );
    expect(calls).toEqual([
      "metadata:Episode 12",
      "handler:play:fn",
      "handler:pause:fn",
      "handler:seekbackward:fn",
      "handler:seekforward:fn",
      "handler:seekto:fn",
      "handler:previoustrack:null",
      "handler:nexttrack:null",
      "state:playing",
      "position:125/600@1",
    ]);
  });

  it("writes nothing when switching off from off", () => {
    const { session, calls } = specSession();
    applyOsMediaSession(
      session,
      OS_SESSION_OFF,
      OS_SESSION_OFF,
      noHandlers,
      metadata,
    );
    expect(calls).toEqual([]);
  });

  it("writes only the state and the position on a pause", () => {
    const { session, calls } = specSession();
    const playing = projectOsMediaSession(PLAYING);
    const paused = projectOsMediaSession({ ...PLAYING, isPlaying: false });
    applyOsMediaSession(session, paused, playing, noHandlers, metadata);
    expect(calls).toEqual(["state:paused", "position:125/600@1"]);
  });

  it("writes the position again on a resume at the same place", () => {
    const { session, calls } = specSession();
    const paused = projectOsMediaSession({ ...PLAYING, isPlaying: false });
    const playing = projectOsMediaSession(PLAYING);
    applyOsMediaSession(session, playing, paused, noHandlers, metadata);
    expect(calls).toEqual(["state:playing", "position:125/600@1"]);
  });

  it("clears the position when the duration disappears", () => {
    const { session, calls } = specSession();
    const next = projectOsMediaSession({ ...PLAYING, durationSec: 0 });
    applyOsMediaSession(
      session,
      next,
      projectOsMediaSession(PLAYING),
      noHandlers,
      metadata,
    );
    expect(calls).toEqual(["position:clear"]);
  });

  it("removes the metadata, handlers and state when the session turns off", () => {
    const { session, calls } = specSession();
    applyOsMediaSession(
      session,
      OS_SESSION_OFF,
      projectOsMediaSession(PLAYING),
      noHandlers,
      metadata,
    );
    expect(calls).toEqual([
      "metadata:null",
      "handler:play:null",
      "handler:pause:null",
      "handler:seekbackward:null",
      "handler:seekforward:null",
      "handler:seekto:null",
      "state:none",
      "position:clear",
    ]);
  });

  it("goes on when a browser refuses an action", () => {
    const { session, calls } = specSession();
    const refusing: MediaSessionLike = Object.create(session, {
      setActionHandler: {
        value: (
          action: MediaSessionAction,
          handler: MediaSessionActionHandler | null,
        ) => {
          if (action === "seekto") throw new TypeError("unsupported");
          session.setActionHandler(action, handler);
        },
      },
    });
    applyOsMediaSession(
      refusing,
      projectOsMediaSession(PLAYING),
      OS_SESSION_OFF,
      noHandlers,
      metadata,
    );
    expect(calls).toContain("state:playing");
    expect(calls).not.toContain("handler:seekto:fn");
  });
});

describe("osActionHandlers", () => {
  function fakeCommands(playing: boolean) {
    const calls: string[] = [];
    let isPlaying = playing;
    return {
      calls,
      cmd: {
        isPlaying: () => isPlaying,
        livePositionSec: () => 88,
        previewActive: () => false,
        stopPreview: () => calls.push("stopPreview"),
        syncPlayhead: (sec: number) => calls.push(`sync:${sec}`),
        togglePlay: () => {
          isPlaying = !isPlaying;
          calls.push("toggle");
        },
        skip: (delta: number) => calls.push(`skip:${delta}`),
        seek: (sec: number) => calls.push(`seek:${sec}`),
      },
    };
  }
  const details = (extra: Partial<MediaSessionActionDetails> = {}) =>
    ({ action: "seekto", ...extra }) as MediaSessionActionDetails;

  it("play toggles only while paused", () => {
    const paused = fakeCommands(false);
    osActionHandlers(paused.cmd).play(details());
    expect(paused.calls).toEqual(["toggle"]);
    const playing = fakeCommands(true);
    osActionHandlers(playing.cmd).play(details());
    expect(playing.calls).toEqual([]);
  });

  it("pause syncs the playhead from the live clock before toggling", () => {
    const playing = fakeCommands(true);
    osActionHandlers(playing.cmd).pause(details());
    expect(playing.calls).toEqual(["sync:88", "toggle"]);
    const paused = fakeCommands(false);
    osActionHandlers(paused.cmd).pause(details());
    expect(paused.calls).toEqual([]);
  });

  it.each([
    ["seekbackward", undefined, -15],
    ["seekforward", undefined, 15],
    ["seekbackward", 10, -10],
    ["seekforward", 30, 30],
    ["seekbackward", -5, -15],
    ["seekforward", -5, 15],
    ["seekforward", 0, 15],
    ["seekbackward", Number.NaN, -15],
    ["seekforward", Number.POSITIVE_INFINITY, 15],
  ] as const)("%s with offset %s skips %s s", (name, seekOffset, delta) => {
    const { cmd, calls } = fakeCommands(true);
    osActionHandlers(cmd)[name](details({ seekOffset }));
    expect(calls).toEqual([`skip:${delta}`]);
  });

  it("seekto seeks to the finite time and ignores the rest", () => {
    const { cmd, calls } = fakeCommands(true);
    const { seekto } = osActionHandlers(cmd);
    seekto(details({ seekTime: 40 }));
    seekto(details({ seekTime: 40, fastSeek: true }));
    seekto(details({ seekTime: Number.NaN }));
    seekto(details());
    expect(calls).toEqual(["seek:40", "seek:40"]);
  });
});

describe("transport store projection", () => {
  const share = "share:token";

  beforeEach(() => {
    useDawStore.setState({
      projectPath: share,
      project: minimalProject({
        meta: { name: "Episode 12", workspace_dir: "/tmp/x" },
        timeline_duration_sec: 600,
        tracks: [sampleTrack()],
      }),
      isPlaying: false,
      sourcePreview: null,
      playbackRate: 1,
      playheadSec: 0,
      playheadSeekRevision: 0,
    });
  });

  it("is off outside a share link", () => {
    useDawStore.setState({ projectPath: "/tmp/test/episode.sharecut" });
    expect(
      projectOsMediaSession(osTransportInput(useDawStore.getState(), 0)),
    ).toEqual(OS_SESSION_OFF);
  });

  it("is off while the project has nothing to play", () => {
    useDawStore.setState({
      project: minimalProject({ tracks: [] }),
    });
    expect(
      projectOsMediaSession(osTransportInput(useDawStore.getState(), 0))
        .handlersOn,
    ).toBe(false);
  });

  it("reads the title, duration and rate from the store", () => {
    useDawStore.setState({ playbackRate: 2, isPlaying: true });
    expect(
      projectOsMediaSession(osTransportInput(useDawStore.getState(), 30)),
    ).toEqual({
      metadata: { title: "Episode 12" },
      playbackState: "playing",
      positionState: { duration: 600, playbackRate: 2, position: 30 },
      handlersOn: true,
    });
  });

  it("hands the OS the episode end when a clip runs past the stored duration", () => {
    useDawStore.setState({
      project: minimalProject({
        timeline_duration_sec: 60,
        tracks: [sampleTrack()],
        clips: {
          tracks: { "mira-voice": [clipRow({ timeline_end: 90 })] },
          clip_count: 1,
        },
      }),
    });
    expect(
      projectOsMediaSession(osTransportInput(useDawStore.getState(), 70))
        .positionState,
    ).toEqual({ duration: 90, playbackRate: 1, position: 70 });
  });

  it("keeps one key across playback playhead writes and changes it on a play, seek or rate change", () => {
    const keyOf = () => osDiscontinuityKey(useDawStore.getState());
    const base = keyOf();
    for (let sec = 0; sec < 200; sec += 1)
      useDawStore.getState().setPlayheadSec(sec / 10, "playback");
    expect(keyOf()).toBe(base);

    const keys = new Set([base]);
    useDawStore.getState().setIsPlaying(true);
    keys.add(keyOf());
    useDawStore.getState().setPlayheadSec(40, "seek");
    keys.add(keyOf());
    useDawStore.getState().setPlaybackRate(2);
    keys.add(keyOf());
    expect(keys.size).toBe(4);
  });
});
