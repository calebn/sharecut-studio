import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { STAGE_FOR_TAB, tabForStage } from "../state/stageRoutes";
import { minimalProject, sampleTrack, sessionRoster } from "../test/fixtures";
import type { PresenceTab } from "../types/session";
import { useFollowUi } from "./useFollowUi";

const tracks = [sampleTrack({ id: "host" })];

/** The wire tab of what the follower is showing. */
const shownTab = () => {
  const { stage, reviewSection } = useDawStore.getState();
  return tabForStage(stage, reviewSection);
};

/** What the follower chose for itself: the stage a tab lives in. */
const choose = (tab: PresenceTab) => {
  const { stage, section } = STAGE_FOR_TAB[tab];
  useDawStore.setState({
    stage,
    ...(section ? { reviewSection: section } : {}),
  });
};

function leader(
  ui: Record<string, unknown>,
  extraMeta: Record<string, unknown> = {},
) {
  return {
    client_id: "a",
    role: "viewer" as const,
    last_seen_ns: Date.now() * 1e6,
    meta: { ui, ...extraMeta },
  };
}

describe("useFollowUi", () => {
  beforeEach(() => {
    useDawStore
      .getState()
      .hydrate("/tmp/ep.project.json", minimalProject({ tracks }));
    useDawStore.setState({
      shellBreakpoint: "desktop",
      guestMode: null,
      followingClientId: "a",
      stage: "edit",
      auditionMode: "mix",
      viewerMute: {},
      soloTracks: {},
      followDegraded: {},
      sessionClients: sessionRoster([leader({ tab: "comments" })]),
    });
  });

  it("mirrors the leader tab without unfollowing", () => {
    renderHook(() => useFollowUi());
    expect(shownTab()).toBe("comments");
    expect(useDawStore.getState().followingClientId).toBe("a");
  });

  it("degrades a host-only tab for guests", () => {
    useDawStore.setState({
      guestMode: "view",
      sessionClients: sessionRoster([leader({ tab: "pipeline" })]),
    });
    renderHook(() => useFollowUi());
    expect(shownTab()).toBe("transcript");
    expect(useDawStore.getState().followDegraded.tab).toBe("pipeline");
    expect(useDawStore.getState().followingClientId).toBe("a");
  });

  it("forces Mix when a guest follows a leader on FX", () => {
    useDawStore.setState({
      guestMode: "view",
      auditionMode: "fx",
      sessionClients: sessionRoster([
        leader({ tab: "transcript", audition: "fx" }),
      ]),
    });
    renderHook(() => useFollowUi());
    expect(useDawStore.getState().auditionMode).toBe("mix");
    expect(useDawStore.getState().followDegraded.audition).toBe("fx");
    expect(useDawStore.getState().followingClientId).toBe("a");
  });

  it("forces Mix when a guest follows a leader with no audition field", () => {
    useDawStore.setState({
      guestMode: "view",
      auditionMode: "fx",
      sessionClients: sessionRoster([leader({ tab: "transcript" })]),
    });
    renderHook(() => useFollowUi());
    expect(useDawStore.getState().auditionMode).toBe("mix");
    expect(useDawStore.getState().followDegraded.audition).toBeUndefined();
  });

  it("opens the leader's stage on the first tick", () => {
    useDawStore.setState({
      stage: "review",
      reviewSection: "comments",
      openSheet: "view",
      sessionClients: sessionRoster([leader({ tab: "comments" })]),
    });
    renderHook(() => useFollowUi());
    expect(shownTab()).toBe("comments");
    expect(useDawStore.getState().openSheet).toBeNull();
    expect(useDawStore.getState().followingClientId).toBe("a");
  });

  it("keeps a follower's sheet until the leader changes stage", () => {
    const { rerender } = renderHook(() => useFollowUi());
    expect(shownTab()).toBe("comments");
    useDawStore.setState({ openSheet: "view" });
    useDawStore.setState({
      sessionClients: sessionRoster([
        leader({ tab: "comments", audition: "fx" }),
      ]),
    });
    rerender();
    expect(useDawStore.getState().openSheet).toBe("view");
    useDawStore.setState({
      sessionClients: sessionRoster([
        leader({ tab: "comments", transcript_anchor: "transcript:turn:0" }),
      ]),
    });
    rerender();
    expect(useDawStore.getState().openSheet).toBe("view");
    useDawStore.setState({
      sessionClients: sessionRoster([leader({ tab: "transcript" })]),
    });
    rerender();
    expect(shownTab()).toBe("transcript");
    expect(useDawStore.getState().openSheet).toBeNull();
  });

  it("opens History over Edit for a leader on the history tab", () => {
    useDawStore.setState({
      sessionClients: sessionRoster([leader({ tab: "history" })]),
    });
    renderHook(() => useFollowUi());
    expect(useDawStore.getState().stage).toBe("edit");
    expect(useDawStore.getState().openSheet).toBe("history");
  });

  it("follows the leader's phone surface in Edit", () => {
    useDawStore.setState({
      shellBreakpoint: "phone",
      editSurface: "lanes",
      sessionClients: sessionRoster([
        leader({ tab: "transcript", mobile_mode: "text" }),
      ]),
    });
    renderHook(() => useFollowUi());
    expect(useDawStore.getState().stage).toBe("edit");
    expect(useDawStore.getState().editSurface).toBe("text");
  });

  it("keeps a tab the follower chose until the leader's tab changes", () => {
    const { rerender } = renderHook(() => useFollowUi());
    expect(shownTab()).toBe("comments");
    choose("transcript");
    useDawStore.setState({
      sessionClients: sessionRoster([
        leader({ tab: "comments", audition: "fx" }),
      ]),
    });
    rerender();
    expect(shownTab()).toBe("transcript");
    expect(useDawStore.getState().followingClientId).toBe("a");
    useDawStore.setState({
      sessionClients: sessionRoster([leader({ tab: "pipeline" })]),
    });
    rerender();
    expect(shownTab()).toBe("pipeline");
  });

  it("ignores a leader tab flip it never saw and follows one it did", () => {
    const { rerender } = renderHook(() => useFollowUi());
    expect(shownTab()).toBe("comments");
    choose("transcript");
    // Leader went comments -> pipeline -> comments between two renders.
    useDawStore.setState({
      sessionClients: sessionRoster([
        leader({ tab: "comments", transcript_anchor: "transcript:turn:0" }),
      ]),
    });
    rerender();
    expect(shownTab()).toBe("transcript");
    // A flip the hook does see is mirrored at each step.
    useDawStore.setState({
      sessionClients: sessionRoster([leader({ tab: "pipeline" })]),
    });
    rerender();
    expect(shownTab()).toBe("pipeline");
    useDawStore.setState({
      sessionClients: sessionRoster([leader({ tab: "comments" })]),
    });
    rerender();
    expect(shownTab()).toBe("comments");
  });

  it("applies the same ui only once", () => {
    let tabSets = 0;
    const orig = useDawStore.getState().openStage;
    useDawStore.setState({
      openStage: (stage, options) => {
        tabSets += 1;
        orig(stage, options);
      },
    });
    const { rerender } = renderHook(() => useFollowUi());
    expect(tabSets).toBe(1);
    useDawStore.setState({
      sessionClients: sessionRoster([leader({ tab: "comments" })]),
    });
    rerender();
    expect(tabSets).toBe(1);
  });

  it("scrolls after a combined tab and transcript_anchor tick", () => {
    useDawStore.setState({
      stage: "review",
      sessionClients: sessionRoster([
        leader({
          tab: "transcript",
          transcript_anchor: "transcript:turn:0",
        }),
      ]),
    });
    renderHook(() => useFollowUi());
    expect(shownTab()).toBe("transcript");
    expect(useDawStore.getState().transcriptScrollRequest).toBe(
      "transcript:turn:0",
    );
  });

  it("does not reapply mute when only transcript_anchor changes", () => {
    useDawStore.setState({
      viewerMute: {},
      sessionClients: sessionRoster([
        leader({ tab: "transcript", viewer_mute: [] }),
      ]),
    });
    const { rerender } = renderHook(() => useFollowUi());
    expect(useDawStore.getState().viewerMute).toEqual({});
    useDawStore.setState({ viewerMute: { guest: true } });
    useDawStore.setState({
      sessionClients: sessionRoster([
        leader({
          tab: "transcript",
          viewer_mute: [],
          transcript_anchor: "transcript:turn:1",
        }),
      ]),
    });
    rerender();
    expect(useDawStore.getState().viewerMute).toEqual({ guest: true });
  });

  it("replans when guestMode changes for the same ui payload", () => {
    useDawStore.setState({
      sessionClients: sessionRoster([leader({ tab: "pipeline" })]),
    });
    const { rerender } = renderHook(() => useFollowUi());
    expect(shownTab()).toBe("pipeline");
    expect(useDawStore.getState().followDegraded.tab).toBeUndefined();
    useDawStore.setState({ guestMode: "view" });
    rerender();
    expect(useDawStore.getState().followDegraded.tab).toBe("pipeline");
  });

  it("clears a stale degrade banner when the follow target changes", () => {
    renderHook(() => useFollowUi());
    useDawStore.setState({
      followDegraded: { tab: "pipeline" },
      followingClientId: "b",
      sessionClients: sessionRoster([
        {
          client_id: "b",
          role: "viewer" as const,
          last_seen_ns: Date.now() * 1e6,
        },
      ]),
    });
    renderHook(() => useFollowUi());
    expect(useDawStore.getState().followDegraded).toEqual({});
  });

  it("mirrors the leader inspector selection without unfollowing", () => {
    useDawStore.getState().hydrate(
      "/tmp/ep.project.json",
      minimalProject({
        tracks,
        envelopes: [
          {
            track_id: "host",
            parameter: "volume",
            points: [
              { id: "early", time: 0, value: 1 },
              { id: "late", time: 4, value: 0.5 },
            ],
          },
        ],
      }),
    );
    useDawStore.getState().setLayerVisible("showLevels", false);
    useDawStore.setState({
      selection: null,
      followingClientId: "a",
      sessionClients: sessionRoster([
        leader(
          { tab: "comments" },
          {
            selection: {
              kind: "envelopePoint",
              id: "late",
              track_id: "host",
              time: 4,
            },
          },
        ),
      ]),
    });
    renderHook(() => useFollowUi());
    expect(useDawStore.getState().selection).toEqual({
      kind: "envelopePoint",
      trackId: "host",
      pointId: "late",
    });
    expect(useDawStore.getState().layers.showLevels).toBe(true);
    expect(useDawStore.getState().followingClientId).toBe("a");
  });

  it("clears inspector selection when the leader drops the key", () => {
    useDawStore.setState({
      selection: { kind: "track", trackId: "host" },
      sessionClients: sessionRoster([
        leader(
          { tab: "comments" },
          { selection: { kind: "track", track_id: "host" } },
        ),
      ]),
    });
    const { rerender } = renderHook(() => useFollowUi());
    expect(useDawStore.getState().selection).toEqual({
      kind: "track",
      trackId: "host",
    });
    useDawStore.setState({
      sessionClients: sessionRoster([leader({ tab: "comments" })]),
    });
    rerender();
    expect(useDawStore.getState().selection).toBeNull();
  });
});
