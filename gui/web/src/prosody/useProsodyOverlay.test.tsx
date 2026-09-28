import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeProjectPatch } from "../document/projectPatch";
import { shareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";

const loadProsodyOverlay = vi.hoisted(() => vi.fn());
vi.mock("../api/prosody", () => ({ loadProsodyOverlay }));

const { useProsodyOverlay, useProsodyOverlayViews, resetProsodyOverlay } =
  await import("./useProsodyOverlay");

const PAYLOAD = { schema: "prosody_overlay.v1", tracks: [] };

function job(id: string, status: string) {
  return {
    id,
    project_path: "/tmp/p.json",
    from_step: null,
    only_step: null,
    status,
    current: null,
    total: null,
    message: null,
    error: null,
    elapsed_sec: 0,
    steps: [],
  };
}

describe("useProsodyOverlay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    loadProsodyOverlay.mockReset();
    loadProsodyOverlay.mockResolvedValue(PAYLOAD);
    resetProsodyOverlay();
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    useDawStore.setState({ pipelineJob: null, activityJob: null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function settle() {
    await act(async () => {
      vi.advanceTimersByTime(250);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("fetches once after the debounce and returns the payload", async () => {
    const { result } = renderHook(() => useProsodyOverlay(true));
    expect(loadProsodyOverlay).not.toHaveBeenCalled();
    await settle();
    expect(loadProsodyOverlay).toHaveBeenCalledTimes(1);
    expect(loadProsodyOverlay.mock.calls[0]![0]).toBe("/tmp/p.json");
    expect(result.current).toEqual(PAYLOAD);
  });

  it("makes one fetch for two mounted consumers", async () => {
    renderHook(() => useProsodyOverlay(true));
    renderHook(() => useProsodyOverlay(true));
    await settle();
    expect(loadProsodyOverlay).toHaveBeenCalledTimes(1);
  });

  it("makes no fetch when disabled", async () => {
    const { result } = renderHook(() => useProsodyOverlay(false));
    await settle();
    expect(loadProsodyOverlay).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  it("makes no fetch for a share key", async () => {
    useDawStore.getState().hydrate(shareProjectKey("tok"), minimalProject());
    const { result } = renderHook(() => useProsodyOverlay(true));
    await settle();
    expect(loadProsodyOverlay).not.toHaveBeenCalled();
    expect(result.current).toBeNull();
  });

  it("refetches when the project object changes", async () => {
    renderHook(() => useProsodyOverlay(true));
    await settle();
    expect(loadProsodyOverlay).toHaveBeenCalledTimes(1);
    act(() => {
      useDawStore.setState((s) => ({ project: { ...s.project! } }));
    });
    await settle();
    expect(loadProsodyOverlay).toHaveBeenCalledTimes(2);
  });

  it("refetches on a pipeline job id/status change", async () => {
    renderHook(() => useProsodyOverlay(true));
    await settle();
    expect(loadProsodyOverlay).toHaveBeenCalledTimes(1);
    act(() => {
      useDawStore.setState({ pipelineJob: job("job-1", "running") });
    });
    await settle();
    expect(loadProsodyOverlay).toHaveBeenCalledTimes(2);
  });

  it("refetches on an agent (activity) job id/status change", async () => {
    renderHook(() => useProsodyOverlay(true));
    await settle();
    expect(loadProsodyOverlay).toHaveBeenCalledTimes(1);
    act(() => {
      useDawStore.setState({ activityJob: job("agent-1", "running") });
    });
    await settle();
    expect(loadProsodyOverlay).toHaveBeenCalledTimes(2);
  });

  it("refetches when the layer is turned back on", async () => {
    const { rerender } = renderHook(({ on }) => useProsodyOverlay(on), {
      initialProps: { on: true },
    });
    await settle();
    expect(loadProsodyOverlay).toHaveBeenCalledTimes(1);
    rerender({ on: false });
    rerender({ on: true });
    await settle();
    expect(loadProsodyOverlay).toHaveBeenCalledTimes(2);
  });

  it("clears every mounted consumer when the shared entry is reset", async () => {
    const a = renderHook(() => useProsodyOverlay(true));
    const b = renderHook(() => useProsodyOverlay(true));
    await settle();
    expect(a.result.current).toEqual(PAYLOAD);
    expect(b.result.current).toEqual(PAYLOAD);
    act(() => {
      resetProsodyOverlay();
    });
    expect(a.result.current).toBeNull();
    expect(b.result.current).toBeNull();
  });

  it("hides the aligned view after a clip edit until the refetch lands", async () => {
    const { result } = renderHook(() => useProsodyOverlayViews(true));
    await settle();
    expect(result.current.aligned).toEqual(PAYLOAD);
    expect(result.current.latest).toEqual(PAYLOAD);
    act(() => {
      useDawStore.setState((s) => ({
        project: { ...s.project!, clips: { ...s.project!.clips } },
      }));
    });
    expect(result.current.aligned).toBeNull();
    expect(result.current.latest).toEqual(PAYLOAD);
    await settle();
    expect(result.current.aligned).toEqual(PAYLOAD);
    expect(loadProsodyOverlay).toHaveBeenCalledTimes(2);
  });

  it("keeps the aligned payload across a non-clip project change", async () => {
    const { result } = renderHook(() => useProsodyOverlayViews(true));
    await settle();
    expect(result.current.aligned).toEqual(PAYLOAD);
    act(() => {
      useDawStore.setState((s) => ({ project: { ...s.project! } }));
    });
    expect(result.current.aligned).toEqual(PAYLOAD);
  });

  it("keeps the aligned payload across a non-clip edit merged through the real document-sync path", async () => {
    const { result } = renderHook(() => useProsodyOverlayViews(true));
    await settle();
    expect(result.current.aligned).toEqual(PAYLOAD);
    act(() => {
      useDawStore.setState((s) => ({
        project: mergeProjectPatch(s.project!, {
          transcript: { utterances: [] },
        }),
      }));
    });
    expect(result.current.aligned).toEqual(PAYLOAD);
  });

  it("returns a stable views object while nothing changes", async () => {
    const { result, rerender } = renderHook(() => useProsodyOverlayViews(true));
    await settle();
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it("drops the payload when a refetch fails", async () => {
    const { result } = renderHook(() => useProsodyOverlay(true));
    await settle();
    expect(result.current).toEqual(PAYLOAD);
    loadProsodyOverlay.mockRejectedValueOnce(new TypeError("network"));
    act(() => {
      useDawStore.setState((s) => ({ project: { ...s.project! } }));
    });
    await settle();
    expect(result.current).toBeNull();
  });

  it("keeps the payload when a pending fetch is aborted by a newer request", async () => {
    const { result } = renderHook(() => useProsodyOverlay(true));
    await settle();
    expect(result.current).toEqual(PAYLOAD);
    act(() => {
      useDawStore.setState((s) => ({ project: { ...s.project! } }));
    });
    act(() => {
      useDawStore.setState((s) => ({ project: { ...s.project! } }));
    });
    await settle();
    expect(result.current).toEqual(PAYLOAD);
    expect(loadProsodyOverlay).toHaveBeenCalledTimes(2);
  });
});
