import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { minimalProject } from "../test/fixtures";
import type { SessionState } from "../types/session";
import { estimateTimelineViewportWidth, useDawStore } from "./dawStore";

describe("dawStore timeline viewport width", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useDawStore.setState({ shellBreakpoint: "desktop" });
  });

  it("estimates the time column per shell", () => {
    vi.stubGlobal("visualViewport", { width: 1280 });
    expect(estimateTimelineViewportWidth("desktop")).toBe(780);
    expect(estimateTimelineViewportWidth("tablet")).toBe(1080);
    expect(estimateTimelineViewportWidth("phone")).toBe(1280);
    vi.stubGlobal("visualViewport", { width: 300 });
    expect(estimateTimelineViewportWidth("desktop")).toBe(200);
  });

  it("starts at a non-zero width before the timeline measures", () => {
    expect(useDawStore.getInitialState().timelineViewportWidth).toBeGreaterThan(
      0,
    );
  });

  it("resets a stale measured width to the current shell's estimate", () => {
    vi.stubGlobal("visualViewport", { width: 390 });
    useDawStore.setState({
      shellBreakpoint: "phone",
      timelineViewportWidth: 777,
    });
    useDawStore.getState().resetTimelineViewportWidth();
    expect(useDawStore.getState().timelineViewportWidth).toBe(390);
  });
});

function agentSession(partial: Partial<SessionState> = {}): SessionState {
  return {
    version: 1,
    server_seq: 0,
    origin: "agent",
    last_role: "agent",
    updated_at_ns: 0,
    last_command_id: "c1",
    playhead_sec: 5,
    is_playing: true,
    audition_mode: "mix",
    region: { start_sec: 4, end_sec: 8 },
    source: null,
    track_id: null,
    query: null,
    match_index: null,
    selection: null,
    viewer_mute: {},
    solo_tracks: {},
    tier: null,
    dry_run: false,
    ...partial,
  };
}

describe("dawStore listen-first transport", () => {
  beforeEach(() => {
    useDawStore.getState().hydrate("/tmp/ep.project.json", minimalProject());
    useDawStore.setState({
      playSkipStartSec: null,
      playSkipEndSec: null,
      playAbFollowup: null,
      auditionEpoch: 0,
      isPlaying: false,
    });
  });

  it("hydrate resets follow identity and clock offset", () => {
    useDawStore.setState({
      localClientId: "old",
      serverClockOffsetMs: 12,
      followingClientId: "peer",
      followDegraded: { tab: "pipeline" },
      transcriptScrollRequest: "transcript:turn:0",
      transcriptViewAnchor: "transcript:turn:3",
    });
    useDawStore.getState().hydrate("/tmp/other.json", minimalProject());
    const s = useDawStore.getState();
    expect(s.localClientId).toBeNull();
    expect(s.serverClockOffsetMs).toBe(0);
    expect(s.followingClientId).toBeNull();
    expect(s.followDegraded).toEqual({});
    expect(s.transcriptScrollRequest).toBeNull();
    expect(s.transcriptViewAnchor).toBeNull();
  });

  it("keeps local client id when hydrating the same project path", () => {
    useDawStore.setState({ localClientId: "guest-tok-viewer-ab" });
    useDawStore.getState().hydrate("/tmp/ep.project.json", minimalProject());
    expect(useDawStore.getState().localClientId).toBe("guest-tok-viewer-ab");
  });

  it("hydrate resets per-project transport status (#78)", () => {
    useDawStore.setState({
      audioError: "Failed to load audio (premix)",
      isPlaying: true,
      playheadSec: 42,
      playbackRate: 1.25,
      viewerMute: { host: true },
      soloTracks: { guest: true },
      sessionRegion: { start_sec: 1, end_sec: 2 },
      lastAgentQuery: "play the intro",
      playUntilSec: 10,
      auditionEpoch: 3,
      highlightStaleRender: true,
      renderPreviewBusy: true,
    });
    useDawStore.getState().hydrate("/tmp/other.json", minimalProject());
    const s = useDawStore.getState();
    expect(s.audioError).toBeNull();
    expect(s.isPlaying).toBe(false);
    expect(s.playheadSec).toBe(0);
    expect(s.playbackRate).toBe(1);
    expect(s.viewerMute).toEqual({});
    expect(s.soloTracks).toEqual({});
    expect(s.sessionRegion).toBeNull();
    expect(s.lastAgentQuery).toBeNull();
    expect(s.playUntilSec).toBeNull();
    expect(s.auditionEpoch).toBe(0);
    expect(s.highlightStaleRender).toBe(false);
    expect(s.renderPreviewBusy).toBe(false);
  });

  it("keeps transport during same-path hydration and changes the epoch only on project switch", () => {
    const epoch = useDawStore.getState().projectEpoch;
    useDawStore.setState({
      audioError: "Failed to load audio (premix)",
      isPlaying: true,
      playheadSec: 42,
      playbackRate: 1.25,
      viewerMute: { host: true },
      renderPreviewBusy: true,
    });
    useDawStore.getState().hydrate("/tmp/ep.project.json", minimalProject());
    const same = useDawStore.getState();
    expect(same.projectEpoch).toBe(epoch);
    expect(same.audioError).toBe("Failed to load audio (premix)");
    expect(same.isPlaying).toBe(true);
    expect(same.playheadSec).toBe(42);
    expect(same.playbackRate).toBe(1.25);
    expect(same.viewerMute).toEqual({ host: true });
    expect(same.renderPreviewBusy).toBe(true);

    same.hydrate("/tmp/other.json", minimalProject());
    expect(useDawStore.getState().projectEpoch).toBe(epoch + 1);
  });

  it("beginAudition bumps epoch", () => {
    useDawStore.getState().beginAudition({
      playheadSec: 1,
      untilSec: 3,
      skip: { start: 1.5, end: 2 },
    });
    expect(useDawStore.getState().auditionEpoch).toBe(1);
    expect(useDawStore.getState().playSkipStartSec).toBe(1.5);
  });

  it("applyAgentSession clears skip and A/B followup", () => {
    useDawStore.getState().beginAudition({
      playheadSec: 1,
      untilSec: 3,
      skip: { start: 1.5, end: 2 },
      abFollowup: {
        start: 1,
        until: 3,
        skipStart: 1.5,
        skipEnd: 2,
        gapSec: 0.4,
      },
    });
    const epoch = useDawStore.getState().auditionEpoch;
    useDawStore.getState().applyAgentSession(agentSession());
    const s = useDawStore.getState();
    expect(s.playSkipStartSec).toBeNull();
    expect(s.playSkipEndSec).toBeNull();
    expect(s.playAbFollowup).toBeNull();
    expect(s.auditionEpoch).toBe(epoch + 1);
    expect(s.playUntilSec).toBe(8);
  });
});

describe("dawStore clip multi-select", () => {
  beforeEach(() => {
    useDawStore.getState().hydrate(
      "/tmp/ep.project.json",
      minimalProject({
        tracks: [
          {
            id: "host",
            label: "Host",
            role: "dialogue",
            speaker: null,
            gain_db: 0,
            muted: false,
            duration_sec: 10,
            fx_count: 0,
            stem_is_fresh: true,
          },
          {
            id: "guest",
            label: "Guest",
            role: "dialogue",
            speaker: null,
            gain_db: 0,
            muted: false,
            duration_sec: 10,
            fx_count: 0,
            stem_is_fresh: true,
          },
        ],
        clips: {
          clip_count: 2,
          tracks: {
            host: [
              {
                id: "c1",
                track_id: "host",
                source_start: 0,
                source_end: 2,
                timeline_start: 0,
                timeline_end: 2,
                fade_in_ms: 0,
                fade_out_ms: 0,
                join_in_mode: "fade",
                source_id: null,
              },
            ],
            guest: [
              {
                id: "g1",
                track_id: "guest",
                source_start: 0,
                source_end: 2,
                timeline_start: 1,
                timeline_end: 3,
                fade_in_ms: 0,
                fade_out_ms: 0,
                join_in_mode: "fade",
                source_id: null,
              },
            ],
          },
        },
      }),
    );
  });

  it("replaces the set on a plain click", () => {
    const s = useDawStore.getState();
    s.selectClip("c1", "host");
    s.selectClip("g1", "guest");
    expect(useDawStore.getState().selectedClipIds).toEqual(["g1"]);
    expect(useDawStore.getState().selection).toEqual({
      kind: "clip",
      id: "g1",
      trackId: "guest",
    });
  });

  it("Shift-click adds without dropping the previous clip", () => {
    const s = useDawStore.getState();
    s.selectClip("c1", "host");
    s.selectClip("g1", "guest", { shift: true });
    expect(useDawStore.getState().selectedClipIds).toEqual(["c1", "g1"]);
    expect(useDawStore.getState().selection?.kind).toBe("clip");
    expect(useDawStore.getState().selection).toMatchObject({ id: "g1" });
  });

  it("Mod-click toggles membership", () => {
    const s = useDawStore.getState();
    s.selectClip("c1", "host");
    s.selectClip("g1", "guest", { shift: true });
    s.selectClip("c1", "host", { mod: true });
    expect(useDawStore.getState().selectedClipIds).toEqual(["g1"]);
    expect(useDawStore.getState().selection).toMatchObject({ id: "g1" });
  });

  it("clears the multi-set when selection leaves clips", () => {
    useDawStore.getState().selectClip("c1", "host");
    useDawStore.getState().setSelection({ kind: "track", trackId: "host" });
    expect(useDawStore.getState().selectedClipIds).toEqual([]);
  });

  it("keeps the multi-set when the primary clip is already selected", () => {
    useDawStore.getState().selectClip("c1", "host");
    useDawStore.getState().selectClip("g1", "guest", { shift: true });
    useDawStore.getState().setSelection({
      kind: "clip",
      id: "c1",
      trackId: "host",
    });
    expect(useDawStore.getState().selectedClipIds).toEqual(["c1", "g1"]);
  });
});

describe("dawStore follow presence", () => {
  beforeEach(() => {
    useDawStore.getState().hydrate("/tmp/ep.project.json", minimalProject());
  });

  it("omits playhead and playing from viewer snapshot while following", () => {
    useDawStore.setState({ playheadSec: 9, isPlaying: true });
    const before = useDawStore.getState().buildViewerSnapshot();
    expect(before.playhead_sec).toBe(9);
    expect(before.is_playing).toBe(true);
    useDawStore.getState().startFollow("viewer-x");
    const snap = useDawStore.getState().buildViewerSnapshot();
    expect(snap.playhead_sec).toBeUndefined();
    expect(snap.is_playing).toBeUndefined();
    useDawStore.getState().stopFollow("local");
    expect(useDawStore.getState().followingClientId).toBeNull();
    expect(useDawStore.getState().playbackRate).toBe(1);
  });

  it("guest setAuditionMode cannot leave Mix", () => {
    useDawStore
      .getState()
      .hydrate("/tmp/ep.project.json", minimalProject(), "view");
    useDawStore.getState().setAuditionMode("fx");
    expect(useDawStore.getState().auditionMode).toBe("mix");
    useDawStore.getState().setAuditionMode("raw");
    expect(useDawStore.getState().auditionMode).toBe("mix");
    useDawStore.getState().setAuditionMode("mix");
    expect(useDawStore.getState().auditionMode).toBe("mix");
  });

  it("host still applies remote audition and monitor maps", () => {
    useDawStore.getState().applyAgentSession(
      agentSession({
        origin: "viewer",
        last_role: "viewer",
        audition_mode: "fx",
        viewer_mute: { host: true },
        solo_tracks: { guest: true },
      }),
    );
    const s = useDawStore.getState();
    expect(s.auditionMode).toBe("fx");
    expect(s.viewerMute).toEqual({ host: true });
    expect(s.soloTracks).toEqual({ guest: true });
  });

  it.each(["view", "edit"] as const)(
    "guest %s keeps Mix when a session snapshot is FX",
    (guestMode) => {
      useDawStore
        .getState()
        .hydrate("/tmp/ep.project.json", minimalProject(), guestMode);
      useDawStore.setState({
        auditionMode: "fx",
        viewerMute: { guest: true },
        soloTracks: { guest: true },
      });
      useDawStore.getState().applyAgentSession(
        agentSession({
          origin: "viewer",
          last_role: "viewer",
          audition_mode: "fx",
          viewer_mute: { host: true },
          solo_tracks: { guest: true },
        }),
      );
      const echo = useDawStore.getState();
      expect(echo.auditionMode).toBe("mix");
      expect(echo.viewerMute).toEqual({ guest: true });
      expect(echo.soloTracks).toEqual({ guest: true });

      useDawStore.getState().applyAgentSession(
        agentSession({
          origin: "agent",
          last_role: "agent",
          audition_mode: "raw",
          viewer_mute: { host: true },
          solo_tracks: { guest: true },
        }),
      );
      const agent = useDawStore.getState();
      expect(agent.auditionMode).toBe("mix");
      expect(agent.viewerMute).toEqual({ guest: true });
      expect(agent.soloTracks).toEqual({ guest: true });
    },
  );
});
