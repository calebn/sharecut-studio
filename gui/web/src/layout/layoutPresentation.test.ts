import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCommandContext } from "../commands/context";
import { useDawStore } from "../state/dawStore";
import {
  resolveLayoutMode,
  SHORT_TOUCH_LANDSCAPE_MQ,
} from "../state/layoutPresentation";
import { stubMatchMedia } from "../test/matchMedia";
import { useEffectiveLayout } from "./useEffectiveLayout";

afterEach(() => vi.unstubAllGlobals());

describe("adaptive panel presentation", () => {
  it.each([
    ["tablet", true, "timeline"],
    ["tablet", false, "default"],
    ["phone", true, "default"],
    ["desktop", true, "default"],
  ] as const)(
    "resolves %s with short touch landscape %s to %s",
    (shell, short, expected) => {
      expect(resolveLayoutMode("adaptive", shell, short)).toBe(expected);
    },
  );

  it.each(["default", "timeline", "text", "review"] as const)(
    "retains the explicit %s layout in both presentations",
    (requested) => {
      expect(resolveLayoutMode(requested, "tablet", true)).toBe(requested);
      expect(resolveLayoutMode(requested, "tablet", false)).toBe(requested);
    },
  );

  it("restores panels on a media change without changing intent or storage", () => {
    const media = stubMatchMedia(true);
    const writes = vi.spyOn(Storage.prototype, "setItem");
    const removals = vi.spyOn(Storage.prototype, "removeItem");
    useDawStore.setState({ layoutMode: "adaptive", shellBreakpoint: "tablet" });
    const { result } = renderHook(() => useEffectiveLayout());
    expect(result.current).toBe("timeline");
    act(() => media.setMatches(false));
    expect(result.current).toBe("default");
    expect(useDawStore.getState().layoutMode).toBe("adaptive");
    expect(writes).not.toHaveBeenCalled();
    expect(removals).not.toHaveBeenCalled();
    writes.mockRestore();
    removals.mockRestore();
  });

  it("does not treat a stowed Tighten panel as open for commands", () => {
    stubMatchMedia(true);
    useDawStore.setState({
      layoutMode: "adaptive",
      shellBreakpoint: "tablet",
      activeTab: "tighten",
    });
    expect(buildCommandContext().tightenPanelOpen).toBe(false);
    useDawStore.getState().setActiveTab("tighten");
    expect(buildCommandContext().tightenPanelOpen).toBe(true);
  });

  it("subscribes to the single bounded coarse landscape query", () => {
    const media = stubMatchMedia(true);
    const match = vi.spyOn(globalThis, "matchMedia");
    const { unmount } = renderHook(() => useEffectiveLayout());
    expect(
      match.mock.calls.every(([query]) => query === SHORT_TOUCH_LANDSCAPE_MQ),
    ).toBe(true);
    unmount();
    expect(media.removeEventListener).toHaveBeenCalled();
  });
});
