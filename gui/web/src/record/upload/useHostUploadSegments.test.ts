import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { deferred } from "../../test/deferred";
import {
  memoryUploadTransport,
  type RecordUploadStatus,
  type RecordUploadTransport,
} from "./transport";
import { useHostUploadSegments } from "./useRecordUpload";

function status(participant: string): RecordUploadStatus {
  return {
    segments: [
      {
        participant_id: participant,
        take_index: 0,
        segment_index: 0,
        acked_parts: [0],
        file_ack: true,
      },
    ],
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("polls every two seconds and retains the last successful rows on failure", async () => {
  const transport = memoryUploadTransport();
  const read = vi.spyOn(transport, "status").mockResolvedValue(status("first"));
  const { result } = renderHook(() => useHostUploadSegments(transport, true));
  await act(async () => {});
  expect(result.current).toEqual(status("first").segments);
  read.mockRejectedValueOnce(new Error("offline"));
  await act(async () => {
    vi.advanceTimersByTime(1999);
  });
  expect(read).toHaveBeenCalledTimes(1);
  await act(async () => {
    vi.advanceTimersByTime(1);
  });
  expect(read).toHaveBeenCalledTimes(2);
  expect(result.current).toEqual(status("first").segments);
  read.mockResolvedValue(status("next"));
  await act(async () => {
    vi.advanceTimersByTime(2000);
  });
  expect(result.current).toEqual(status("next").segments);
});

it("clears on disable, starts empty on re-enable and rejects the retired response", async () => {
  const transport = memoryUploadTransport();
  const old = deferred<RecordUploadStatus>();
  const fresh = deferred<RecordUploadStatus>();
  const read = vi
    .spyOn(transport, "status")
    .mockResolvedValueOnce(status("first"))
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(fresh.promise);
  const { result, rerender } = renderHook(
    ({ enabled }) => useHostUploadSegments(transport, enabled),
    { initialProps: { enabled: true } },
  );
  await act(async () => {});
  expect(result.current).toEqual(status("first").segments);
  await act(async () => {
    vi.advanceTimersByTime(2000);
  });
  expect(read).toHaveBeenCalledTimes(2);
  rerender({ enabled: false });
  expect(result.current).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
  rerender({ enabled: true });
  expect(read).toHaveBeenCalledTimes(3);
  expect(result.current).toEqual([]);
  await act(async () => {
    old.resolve(status("retired"));
  });
  expect(result.current).toEqual([]);
  await act(async () => {
    fresh.resolve(status("fresh"));
  });
  expect(result.current).toEqual(status("fresh").segments);
});

it("retains prior rows during an active transport change but rejects its old pending result", async () => {
  const a = memoryUploadTransport();
  const b = memoryUploadTransport();
  const old = deferred<RecordUploadStatus>();
  const fresh = deferred<RecordUploadStatus>();
  vi.spyOn(a, "status")
    .mockResolvedValueOnce(status("a"))
    .mockReturnValueOnce(old.promise);
  vi.spyOn(b, "status").mockReturnValue(fresh.promise);
  const { result, rerender } = renderHook(
    ({ transport }) => useHostUploadSegments(transport, true),
    { initialProps: { transport: a as RecordUploadTransport } },
  );
  await act(async () => {});
  await act(async () => {
    vi.advanceTimersByTime(2000);
  });
  rerender({ transport: b });
  expect(result.current).toEqual(status("a").segments);
  await act(async () => {
    old.resolve(status("retired-a"));
  });
  expect(result.current).toEqual(status("a").segments);
  await act(async () => {
    fresh.resolve(status("b"));
  });
  expect(result.current).toEqual(status("b").segments);
});

it("clears for a missing transport and releases its polling interval on unmount", async () => {
  const transport = memoryUploadTransport();
  const pending = deferred<RecordUploadStatus>();
  const read = vi
    .spyOn(transport, "status")
    .mockResolvedValueOnce(status("first"))
    .mockReturnValue(pending.promise);
  const { result, rerender, unmount } = renderHook<
    RecordUploadStatus["segments"],
    { current: RecordUploadTransport | null }
  >(
    ({ current }: { current: RecordUploadTransport | null }) =>
      useHostUploadSegments(current, true),
    { initialProps: { current: transport } },
  );
  await act(async () => {});
  expect(result.current).toEqual(status("first").segments);
  rerender({ current: null });
  expect(result.current).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
  rerender({ current: transport });
  expect(result.current).toEqual([]);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => {
    pending.resolve(status("retired"));
    vi.advanceTimersByTime(6000);
  });
  expect(read).toHaveBeenCalledTimes(2);
});
