import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { seedPendingKeeper } from "../../test/keepers";
import { MemorySink } from "../keeper/store";
import * as recovery from "./recovery";
import { SCAN_TIMEOUT_MS, useLocalKeeper } from "./useLocalKeeper";

const ids = { sessionId: "room1", takeIndex: 0, participantId: "p_g" };

function renderKeeper(sink: MemorySink | null, recheck = 0) {
  return renderHook(
    ({ recheck: key, sink: current }) =>
      useLocalKeeper({ sink: current, ...ids, recheck: key }),
    { initialProps: { sink, recheck } },
  );
}

type Who = { sessionId: string; participantId: string; takeIndex: number };

function renderWho(sink: MemorySink, who: Who) {
  return renderHook(
    ({ recheck, who: current }) =>
      useLocalKeeper({ sink, ...current, recheck }),
    { initialProps: { recheck: 0, who } },
  );
}

async function settle(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
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
    expect(result.current).toMatchObject({
      found: false,
      segments: null,
      failed: false,
    });
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
    expect(result.current).toEqual({ found: true, segments: 2, failed: false });
    scan.mockRejectedValue(new Error("io"));
    rerender({ sink: new MemorySink(), recheck: 1 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(scan).toHaveBeenCalledTimes(4);
    expect(result.current).toMatchObject({ segments: null, failed: true });
  });

  it("gives up on a scan that never settles, then reads the device as unreadable after the retry", async () => {
    vi.useFakeTimers();
    const scan = vi
      .spyOn(recovery, "scanLocalKeeper")
      .mockReturnValue(new Promise(() => undefined));
    const { result } = renderKeeper(new MemorySink());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000 - 1);
    });
    expect(scan).toHaveBeenCalledTimes(1);
    expect(result.current).toMatchObject({ segments: null, failed: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(result.current).toMatchObject({ segments: null, failed: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(scan).toHaveBeenCalledTimes(2);
    expect(result.current).toMatchObject({ segments: null, failed: false });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(result.current).toMatchObject({ segments: null, failed: true });
  });

  it("keeps a scan that settles inside the limit", async () => {
    vi.useFakeTimers();
    vi.spyOn(recovery, "scanLocalKeeper").mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () => resolve({ found: true, segments: 3 }),
            SCAN_TIMEOUT_MS - 100,
          ),
        ),
    );
    const { result } = renderKeeper(new MemorySink());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SCAN_TIMEOUT_MS);
    });
    expect(result.current).toEqual({ found: true, segments: 3, failed: false });
  });

  it("keeps an unreadable device unreadable through the next recheck instead of reading it as unknown again", async () => {
    vi.useFakeTimers();
    const scan = vi
      .spyOn(recovery, "scanLocalKeeper")
      .mockRejectedValue(new Error("io"));
    const sink = new MemorySink();
    const { result, rerender } = renderKeeper(sink);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(result.current).toMatchObject({ segments: null, failed: true });
    const before = scan.mock.calls.length;
    rerender({ sink, recheck: 1 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(scan.mock.calls.length).toBeGreaterThan(before);
    expect(result.current).toMatchObject({ segments: null, failed: true });
    scan.mockResolvedValue({ found: true, segments: 1 });
    rerender({ sink, recheck: 2 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(result.current).toEqual({ found: true, segments: 1, failed: false });
  });
  it("pins the scan timeout to 5 seconds", () => {
    expect(SCAN_TIMEOUT_MS).toBe(5000);
  });

  it("forgets the unreadable verdict after a scan succeeds", async () => {
    vi.useFakeTimers();
    const scan = vi
      .spyOn(recovery, "scanLocalKeeper")
      .mockRejectedValue(new Error("io"));
    const sink = new MemorySink();
    const { result, rerender } = renderKeeper(sink);
    await settle(2100);
    expect(result.current).toMatchObject({ failed: true });
    scan.mockResolvedValue({ found: true, segments: 1 });
    rerender({ sink, recheck: 1 });
    await settle(100);
    expect(result.current).toMatchObject({ found: true, failed: false });
    scan.mockRejectedValue(new Error("io"));
    rerender({ sink, recheck: 2 });
    await settle(100);
    expect(result.current).toMatchObject({ segments: null, failed: false });
    await settle(2100);
    expect(result.current).toMatchObject({ segments: null, failed: true });
  });

  it.each([
    ["session", { ...ids, sessionId: "room2" }],
    ["participant", { ...ids, participantId: "p_other" }],
    ["take", { ...ids, takeIndex: 1 }],
  ])(
    "does not carry an unreadable verdict over to another %s",
    async (_n, other) => {
      vi.useFakeTimers();
      vi.spyOn(recovery, "scanLocalKeeper").mockRejectedValue(new Error("io"));
      const sink = new MemorySink();
      const { result, rerender } = renderWho(sink, ids);
      await settle(2100);
      expect(result.current).toMatchObject({ failed: true });
      rerender({ recheck: 1, who: other });
      await settle(100);
      expect(result.current).toMatchObject({ segments: null, failed: false });
      await settle(2100);
      expect(result.current).toMatchObject({ segments: null, failed: true });
    },
  );

  it("does not carry an unreadable verdict over to another sink", async () => {
    vi.useFakeTimers();
    vi.spyOn(recovery, "scanLocalKeeper").mockRejectedValue(new Error("io"));
    const { result, rerender } = renderKeeper(new MemorySink());
    await settle(2100);
    expect(result.current).toMatchObject({ failed: true });
    rerender({ sink: new MemorySink(), recheck: 1 });
    await settle(100);
    expect(result.current).toMatchObject({ segments: null, failed: false });
    await settle(2100);
    expect(result.current).toMatchObject({ failed: true });
  });
});
