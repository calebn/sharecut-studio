import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shareProjectKey } from "../shareMode";
import { useDawStore } from "../state/dawStore";
import { minimalProject } from "../test/fixtures";

const loadProsodyOverlay = vi.hoisted(() => vi.fn());
vi.mock("../api/prosody", () => ({ loadProsodyOverlay }));

const { useProsodyOverlay, resetProsodyOverlay } = await import(
  "./useProsodyOverlay"
);

const PAYLOAD = { schema: "prosody_overlay.v1", tracks: [] };

describe("useProsodyOverlay", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    loadProsodyOverlay.mockReset();
    loadProsodyOverlay.mockResolvedValue(PAYLOAD);
    resetProsodyOverlay();
    useDawStore.getState().hydrate("/tmp/p.json", minimalProject());
    useDawStore.setState({ pipelineJob: null });
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
      useDawStore.setState({
        pipelineJob: {
          id: "job-1",
          project_path: "/tmp/p.json",
          from_step: null,
          only_step: null,
          status: "running",
          current: null,
          total: null,
          message: null,
          error: null,
          elapsed_sec: 0,
          steps: [],
        },
      });
    });
    await settle();
    expect(loadProsodyOverlay).toHaveBeenCalledTimes(2);
  });
});
