import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerDawCommands } from "../commands/register";
import { useDawStore } from "../state/dawStore";
import { minimalProject, sampleTrack } from "../test/fixtures";
import { trackIdsKey, useCommand } from "./useCommand";

describe("trackIdsKey", () => {
  it("caches the join per tracks array", () => {
    const tracks = [sampleTrack({ id: "a" }), sampleTrack({ id: "b" })];
    const mapSpy = vi.spyOn(tracks, "map");
    expect(trackIdsKey(tracks)).toBe("a,b");
    expect(trackIdsKey(tracks)).toBe("a,b");
    expect(trackIdsKey(tracks)).toBe("a,b");
    expect(mapSpy).toHaveBeenCalledTimes(1);
  });

  it("recomputes for a different array and returns empty for none", () => {
    const a = [sampleTrack({ id: "x" })];
    const b = [sampleTrack({ id: "y" }), sampleTrack({ id: "z" })];
    expect(trackIdsKey(a)).toBe("x");
    expect(trackIdsKey(b)).toBe("y,z");
    expect(trackIdsKey(undefined)).toBe("");
  });
});

describe("useCommand", () => {
  beforeEach(() => {
    registerDawCommands();
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
  });

  afterEach(() => {
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
  });

  it("does not re-derive the tracks key on an unrelated store update", () => {
    const project = minimalProject({
      tracks: [sampleTrack({ id: "a" }), sampleTrack({ id: "b" })],
    });
    useDawStore.getState().hydrate("/tmp/p.json", project);
    const mapSpy = vi.spyOn(project.tracks, "map");
    const { result } = renderHook(() => useCommand("view.zoomIn"));
    expect(result.current.def).toBeTruthy();
    mapSpy.mockClear();
    act(() => {
      useDawStore.getState().setHighlightStaleRender(true);
      useDawStore.getState().setHighlightStaleRender(false);
    });
    expect(mapSpy).not.toHaveBeenCalled();
  });
});
