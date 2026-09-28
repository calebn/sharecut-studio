import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject, sessionRoster } from "../test/fixtures";
import { useFollowUi } from "./useFollowUi";

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
    useDawStore.getState().hydrate("/tmp/ep.project.json", minimalProject());
    useDawStore.setState({
      shellBreakpoint: "desktop",
      guestMode: null,
      followingClientId: "a",
      activeTab: "transcript",
      layoutMode: "default",
      auditionMode: "mix",
      viewerMute: {},
      soloTracks: {},
      followDegraded: {},
      sessionClients: sessionRoster([leader({ tab: "comments" })]),
    });
  });

  it("mirrors the leader tab without unfollowing", () => {
    renderHook(() => useFollowUi());
    expect(useDawStore.getState().activeTab).toBe("comments");
    expect(useDawStore.getState().followingClientId).toBe("a");
  });

  it("degrades a host-only tab for guests", () => {
    useDawStore.setState({
      guestMode: "view",
      sessionClients: sessionRoster([leader({ tab: "pipeline" })]),
    });
    renderHook(() => useFollowUi());
    expect(useDawStore.getState().activeTab).toBe("transcript");
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

  it("reveals the leader tab on the first tick even behind the timeline layout", () => {
    useDawStore.setState({
      activeTab: "comments",
      layoutMode: "timeline",
      sessionClients: sessionRoster([leader({ tab: "comments" })]),
    });
    renderHook(() => useFollowUi());
    expect(useDawStore.getState().activeTab).toBe("comments");
    expect(useDawStore.getState().layoutMode).toBe("default");
    expect(useDawStore.getState().followingClientId).toBe("a");
  });

  it("keeps a follower's timeline layout until the leader changes tab", () => {
    const { rerender } = renderHook(() => useFollowUi());
    expect(useDawStore.getState().activeTab).toBe("comments");
    useDawStore.setState({ layoutMode: "timeline" });
    useDawStore.setState({
      sessionClients: sessionRoster([
        leader({ tab: "comments", audition: "fx" }),
      ]),
    });
    rerender();
    expect(useDawStore.getState().layoutMode).toBe("timeline");
    useDawStore.setState({
      sessionClients: sessionRoster([
        leader({ tab: "comments", transcript_anchor: "transcript:turn:0" }),
      ]),
    });
    rerender();
    expect(useDawStore.getState().layoutMode).toBe("timeline");
    useDawStore.setState({
      sessionClients: sessionRoster([leader({ tab: "transcript" })]),
    });
    rerender();
    expect(useDawStore.getState().activeTab).toBe("transcript");
    expect(useDawStore.getState().layoutMode).toBe("default");
  });

  it("reveals a leader tab the follower holds behind the timeline layout", () => {
    const { rerender } = renderHook(() => useFollowUi());
    expect(useDawStore.getState().activeTab).toBe("comments");
    useDawStore.setState({ activeTab: "transcript", layoutMode: "timeline" });
    useDawStore.setState({
      sessionClients: sessionRoster([leader({ tab: "transcript" })]),
    });
    rerender();
    expect(useDawStore.getState().activeTab).toBe("transcript");
    expect(useDawStore.getState().layoutMode).toBe("default");
  });

  it("keeps a tab the follower chose until the leader's tab changes", () => {
    const { rerender } = renderHook(() => useFollowUi());
    expect(useDawStore.getState().activeTab).toBe("comments");
    useDawStore.setState({ activeTab: "transcript" });
    useDawStore.setState({
      sessionClients: sessionRoster([
        leader({ tab: "comments", audition: "fx" }),
      ]),
    });
    rerender();
    expect(useDawStore.getState().activeTab).toBe("transcript");
    expect(useDawStore.getState().followingClientId).toBe("a");
    useDawStore.setState({
      sessionClients: sessionRoster([leader({ tab: "pipeline" })]),
    });
    rerender();
    expect(useDawStore.getState().activeTab).toBe("pipeline");
  });

  it("ignores a leader tab flip it never saw and follows one it did", () => {
    const { rerender } = renderHook(() => useFollowUi());
    expect(useDawStore.getState().activeTab).toBe("comments");
    useDawStore.setState({ activeTab: "transcript" });
    // Leader went comments -> pipeline -> comments between two renders.
    useDawStore.setState({
      sessionClients: sessionRoster([
        leader({ tab: "comments", transcript_anchor: "transcript:turn:0" }),
      ]),
    });
    rerender();
    expect(useDawStore.getState().activeTab).toBe("transcript");
    // A flip the hook does see is mirrored at each step.
    useDawStore.setState({
      sessionClients: sessionRoster([leader({ tab: "pipeline" })]),
    });
    rerender();
    expect(useDawStore.getState().activeTab).toBe("pipeline");
    useDawStore.setState({
      sessionClients: sessionRoster([leader({ tab: "comments" })]),
    });
    rerender();
    expect(useDawStore.getState().activeTab).toBe("comments");
  });

  it("applies the same ui only once", () => {
    let tabSets = 0;
    const orig = useDawStore.getState().setActiveTab;
    useDawStore.setState({
      setActiveTab: (tab) => {
        tabSets += 1;
        orig(tab);
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
      activeTab: "comments",
      sessionClients: sessionRoster([
        leader({
          tab: "transcript",
          transcript_anchor: "transcript:turn:0",
        }),
      ]),
    });
    renderHook(() => useFollowUi());
    expect(useDawStore.getState().activeTab).toBe("transcript");
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
    expect(useDawStore.getState().activeTab).toBe("pipeline");
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
      index: 1,
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
