import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";
import { useFollowViewport } from "./useFollowViewport";

describe("useFollowViewport", () => {
  beforeEach(() => {
    useDawStore.getState().hydrate("/tmp/ep.project.json", minimalProject());
    useDawStore.setState({
      shellBreakpoint: "desktop",
      followingClientId: "a",
      sessionClients: [
        {
          client_id: "a",
          role: "viewer",
          last_seen_ns: Date.now() * 1e6,
          meta: { viewport: { start_sec: 10, end_sec: 20 } },
        },
      ],
    });
  });

  it("slaves zoom and scroll to the target viewport", () => {
    useDawStore.setState({
      measureTimelineViewport: () => 200,
    });
    renderHook(() => useFollowViewport());
    expect(useDawStore.getState().zoomPxPerSec).toBe(20);
    expect(useDawStore.getState().scrollLeft).toBe(200);
  });

  it("does not slave zoom on phone", () => {
    useDawStore.setState({
      shellBreakpoint: "phone",
      zoomPxPerSec: 12,
      scrollLeft: 0,
      measureTimelineViewport: () => 200,
    });
    renderHook(() => useFollowViewport());
    expect(useDawStore.getState().zoomPxPerSec).toBe(12);
    expect(useDawStore.getState().scrollLeft).toBe(0);
  });

  it("unfollows when the target is stale", () => {
    useDawStore.setState({
      sessionClients: [
        {
          client_id: "a",
          role: "viewer",
          last_seen_ns: 1,
          meta: { viewport: { start_sec: 10, end_sec: 20 } },
        },
      ],
    });
    renderHook(() => useFollowViewport());
    expect(useDawStore.getState().followingClientId).toBeNull();
  });
});
