import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPointerCommand } from "../commands/pointer";
import { useDawStore } from "../state/dawStore";
import { minimalProject, sampleTrack } from "../test/fixtures";
import type { ProjectView } from "../types/project";
import { AUTO_MIX_PREF_KEY } from "./autoMixPref";
import { AUTO_MIX_DEBOUNCE_MS, useAutoRefreshMix } from "./useAutoRefreshMix";

vi.mock("../commands/pointer", () => ({ runPointerCommand: vi.fn() }));

function projectWith(
  renderStatus: Record<string, unknown>,
  stale = true,
): ProjectView {
  return minimalProject({
    tracks: [sampleTrack({ id: "t1", stem_is_fresh: !stale })],
    render_status: {
      needs_rerender: stale,
      reconciliation: { stale: false },
      premix: { exists: true, stale_vs_stems: stale },
      ...renderStatus,
    },
  });
}

const edit = (id: string) =>
  projectWith({
    invalidations: [
      {
        id,
        track_ids: ["t1"],
        timeline_start: null,
        timeline_end: null,
        reason: "cut",
        at: "2026-10-14T00:00:00Z",
      },
    ],
  });

function showProject(project: ProjectView) {
  act(() => {
    useDawStore.getState().setProject(project);
  });
}

describe("useAutoRefreshMix", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(runPointerCommand).mockClear();
    useDawStore.getState().hydrate("/tmp/p.json", projectWith({}, false));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rebuilds a mix that an edit left behind, with no click, after the debounce", () => {
    renderHook(() => useAutoRefreshMix(true));
    showProject(edit("e1"));
    act(() => {
      vi.advanceTimersByTime(AUTO_MIX_DEBOUNCE_MS - 1);
    });
    expect(runPointerCommand).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(runPointerCommand).toHaveBeenCalledTimes(1);
    expect(runPointerCommand).toHaveBeenCalledWith("render.refreshMix", {
      auto: true,
    });
  });

  it("rebuilds once for a burst of edits", () => {
    renderHook(() => useAutoRefreshMix(true));
    showProject(edit("e1"));
    act(() => {
      vi.advanceTimersByTime(AUTO_MIX_DEBOUNCE_MS - 100);
    });
    showProject(edit("e2"));
    act(() => {
      vi.advanceTimersByTime(AUTO_MIX_DEBOUNCE_MS - 100);
    });
    expect(runPointerCommand).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(runPointerCommand).toHaveBeenCalledTimes(1);
  });

  it("opens a project with no mix and builds it", () => {
    useDawStore
      .getState()
      .hydrate("/tmp/p.json", projectWith({ premix: { exists: false } }));
    renderHook(() => useAutoRefreshMix(true));
    act(() => {
      vi.advanceTimersByTime(AUTO_MIX_DEBOUNCE_MS);
    });
    expect(runPointerCommand).toHaveBeenCalledTimes(1);
  });

  it("waits for a running rebuild, then rebuilds for the newer change", () => {
    renderHook(() => useAutoRefreshMix(true));
    showProject(edit("e1"));
    act(() => {
      vi.advanceTimersByTime(AUTO_MIX_DEBOUNCE_MS);
    });
    act(() => useDawStore.getState().setRenderPreviewBusy(true));
    showProject(edit("e2"));
    act(() => {
      vi.advanceTimersByTime(AUTO_MIX_DEBOUNCE_MS * 2);
    });
    expect(runPointerCommand).toHaveBeenCalledTimes(1);
    act(() => useDawStore.getState().setRenderPreviewBusy(false));
    act(() => {
      vi.advanceTimersByTime(AUTO_MIX_DEBOUNCE_MS);
    });
    expect(runPointerCommand).toHaveBeenCalledTimes(2);
  });

  it("does not retry a state the rebuild already tried and could not clear", () => {
    renderHook(() => useAutoRefreshMix(true));
    showProject(edit("e1"));
    act(() => {
      vi.advanceTimersByTime(AUTO_MIX_DEBOUNCE_MS);
    });
    act(() => useDawStore.getState().setRenderPreviewBusy(true));
    act(() => useDawStore.getState().setRenderPreviewBusy(false));
    act(() => {
      vi.advanceTimersByTime(AUTO_MIX_DEBOUNCE_MS * 4);
    });
    expect(runPointerCommand).toHaveBeenCalledTimes(1);
  });

  it("rebuilds again when the same kind of change comes after the mix went fresh", () => {
    renderHook(() => useAutoRefreshMix(true));
    const volumeChange = () =>
      projectWith({ premix: { exists: true, stale_vs_mix: true } }, false);
    showProject(volumeChange());
    act(() => {
      vi.advanceTimersByTime(AUTO_MIX_DEBOUNCE_MS);
    });
    expect(runPointerCommand).toHaveBeenCalledTimes(1);
    showProject(projectWith({}, false));
    showProject(volumeChange());
    act(() => {
      vi.advanceTimersByTime(AUTO_MIX_DEBOUNCE_MS);
    });
    expect(runPointerCommand).toHaveBeenCalledTimes(2);
  });

  it("stays paused while the browser preference is off", () => {
    window.localStorage.setItem(AUTO_MIX_PREF_KEY, "off");
    try {
      renderHook(() => useAutoRefreshMix(true));
      showProject(edit("e1"));
      act(() => {
        vi.advanceTimersByTime(AUTO_MIX_DEBOUNCE_MS * 2);
      });
      expect(runPointerCommand).not.toHaveBeenCalled();
    } finally {
      window.localStorage.removeItem(AUTO_MIX_PREF_KEY);
    }
  });

  it("leaves a fresh mix and a disabled hook alone", () => {
    const { rerender } = renderHook(({ on }) => useAutoRefreshMix(on), {
      initialProps: { on: true },
    });
    act(() => {
      vi.advanceTimersByTime(AUTO_MIX_DEBOUNCE_MS * 2);
    });
    rerender({ on: false });
    showProject(edit("e1"));
    act(() => {
      vi.advanceTimersByTime(AUTO_MIX_DEBOUNCE_MS * 2);
    });
    expect(runPointerCommand).not.toHaveBeenCalled();
  });
});
