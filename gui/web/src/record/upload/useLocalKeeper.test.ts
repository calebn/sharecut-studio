import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { seedPendingKeeper } from "../../test/keepers";
import { MemorySink } from "../keeper/store";
import * as recovery from "./recovery";
import { useLocalKeeper } from "./useLocalKeeper";

const ids = { sessionId: "room1", takeIndex: 0, participantId: "p_g" };

function renderKeeper(sink: MemorySink | null, recheck = 0) {
  return renderHook(
    ({ recheck: key, sink: current }) =>
      useLocalKeeper({ sink: current, ...ids, recheck: key }),
    { initialProps: { sink, recheck } },
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useLocalKeeper", () => {
  it("claims nothing while pending or without a sink", async () => {
    const sink = new MemorySink();
    await seedPendingKeeper(sink, ids);
    expect(renderKeeper(sink).result.current.found).toBe(false);
    expect(renderKeeper(null).result.current.found).toBe(false);
  });

  it("finds a WAV that is still on the device, as after a reload", async () => {
    const sink = new MemorySink();
    await seedPendingKeeper(sink, ids);
    const { result } = renderKeeper(sink);
    await waitFor(() => expect(result.current.found).toBe(true));
  });

  it("counts the segment slots the device holds", async () => {
    const sink = new MemorySink();
    await seedPendingKeeper(sink, ids);
    const { result, rerender } = renderKeeper(sink);
    await waitFor(() => expect(result.current.segments).toBe(1));
    await seedPendingKeeper(sink, { ...ids, segmentIndex: 1 });
    rerender({ sink, recheck: 1 });
    await waitFor(() => expect(result.current.segments).toBe(2));
  });

  it("is false when nothing was kept", async () => {
    const { result } = renderKeeper(new MemorySink());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.found).toBe(false);
  });

  it("drops to false once the keeper is reclaimed and rechecked", async () => {
    const sink = new MemorySink();
    const wavPath = await seedPendingKeeper(sink, ids);
    const { result, rerender } = renderKeeper(sink);
    await waitFor(() => expect(result.current.found).toBe(true));
    await sink.remove(wavPath);
    rerender({ sink, recheck: 1 });
    await waitFor(() => expect(result.current.found).toBe(false));
  });

  it("reports an unknown count while the scan is pending, and when it throws", async () => {
    const sink = new MemorySink();
    await seedPendingKeeper(sink, ids);
    expect(renderKeeper(sink).result.current.segments).toBeNull();
    vi.spyOn(recovery, "scanLocalKeeper").mockRejectedValue(new Error("io"));
    const { result } = renderKeeper(sink);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current).toEqual({ found: false, segments: null });
    vi.restoreAllMocks();
  });

  it("reports a known zero for a device with nothing kept", async () => {
    const { result } = renderKeeper(new MemorySink());
    await waitFor(() => expect(result.current.segments).toBe(0));
  });

  it("scans again after a short delay when a scan threw, once per recheck", async () => {
    vi.useFakeTimers();
    const scan = vi
      .spyOn(recovery, "scanLocalKeeper")
      .mockRejectedValueOnce(new Error("io"))
      .mockResolvedValue({ found: true, segments: 2 });
    const { result, rerender } = renderKeeper(new MemorySink());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.segments).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(scan).toHaveBeenCalledTimes(2);
    expect(result.current).toEqual({ found: true, segments: 2 });
    scan.mockRejectedValue(new Error("io"));
    rerender({ sink: new MemorySink(), recheck: 1 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(scan).toHaveBeenCalledTimes(4);
  });
});
