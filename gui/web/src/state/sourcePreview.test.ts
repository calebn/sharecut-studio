import { beforeEach, describe, expect, it, vi } from "vitest";
import { minimalProject } from "../test/fixtures";
import { useDawStore } from "./dawStore";

const request = {
  ownerId: "wordbar",
  media: {
    kind: "raw" as const,
    trackId: "host",
    sourceId: "extra",
    cacheKey: "asset",
  },
  startSec: 1,
  endSec: 2,
};
beforeEach(() =>
  useDawStore.getState().hydrate("/tmp/source-preview", minimalProject()),
);
describe("local source preview ownership", () => {
  it("keeps the timeline clock and publishes no source clock in viewer state", () => {
    const s = useDawStore.getState();
    s.setPlayheadSec(42);
    s.beginSourcePreview(request);
    const active = useDawStore.getState().sourcePreview;
    expect(active).not.toBeNull();
    if (!active) throw new Error("preview missing");
    s.updateSourcePreview(active.ownerId, active.generation, 1.5);
    expect(useDawStore.getState().playheadSec).toBe(42);
    expect(useDawStore.getState().isPlaying).toBe(false);
    expect(useDawStore.getState().sourcePreviewPositionSec).toBe(1.5);
    expect(JSON.stringify(s.buildViewerSnapshot())).not.toContain(
      "sourcePreview",
    );
  });
  it("ends follow once when a source preview starts, and is silent when not following", () => {
    const announce = vi.fn();
    useDawStore.setState({
      followingClientId: "other",
      playbackRate: 1.5,
      announceStatus: announce,
    });
    useDawStore.getState().beginSourcePreview(request);
    expect(useDawStore.getState().followingClientId).toBeNull();
    expect(useDawStore.getState().playbackRate).toBe(1);
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce.mock.calls[0]?.[0]).toBe("Stopped following");
    useDawStore
      .getState()
      .beginSourcePreview({ ...request, startSec: 3, endSec: 4 });
    expect(announce).toHaveBeenCalledTimes(1);
  });
  it("an explicit Stop cancels preview even when the timeline is already stopped", () => {
    useDawStore.getState().beginSourcePreview(request);
    useDawStore.getState().stopPlayback();
    expect(useDawStore.getState().sourcePreview).toBeNull();
  });
  it("does not let old cleanup or progress overwrite a new owner or generation", () => {
    const s = useDawStore.getState();
    s.beginSourcePreview(request);
    const old = useDawStore.getState().sourcePreview;
    if (!old) throw new Error("preview missing");
    s.releaseSourcePreview(request.ownerId);
    s.beginSourcePreview({ ...request, startSec: 3, endSec: 4 });
    s.updateSourcePreview(old.ownerId, old.generation, 1.5, true, {
      kind: "unavailable",
      message: "old error",
    });
    expect(useDawStore.getState().sourcePreview?.playing).toBe(true);
    expect(useDawStore.getState().sourcePreviewError).toBeNull();
    s.beginSourcePreview({ ...request, ownerId: "new" });
    s.releaseSourcePreview(request.ownerId);
    expect(useDawStore.getState().sourcePreview?.ownerId).toBe("new");
  });
  it("clears preview on timeline seek and project change", () => {
    const s = useDawStore.getState();
    s.beginSourcePreview(request);
    s.setPlayheadSec(55);
    expect(useDawStore.getState().sourcePreview).toBeNull();
    s.beginSourcePreview(request);
    s.hydrate("/tmp/another-project", minimalProject());
    expect(useDawStore.getState().sourcePreview).toBeNull();
  });
});
