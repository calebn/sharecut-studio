import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, useLayoutEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pcmWavHeader } from "../../audio/wavHeader";
import { deferred } from "../../test/deferred";
import { keeperMetaBytes } from "../../test/keepers";
import { keeperMetaPath, keeperWavPath, MemorySink } from "../keeper/store";
import {
  memoryUploadTransport,
  type RecordUploadStatus,
  type RecordUploadTransport,
} from "./transport";
import { type RecordUploadProgress, useRecordUpload } from "./useRecordUpload";

type Args = Parameters<typeof useRecordUpload>[0];
type Seen = { args: Args; progress: RecordUploadProgress };

function initialArgs(transport: RecordUploadTransport): Args {
  return {
    enabled: true,
    roomState: "recording",
    captureSettled: false,
    sessionId: "room",
    takeIndex: 0,
    participantId: "p_a",
    transport,
    sink: new MemorySink(),
    captureExpected: false,
    retryNonce: 0,
  };
}

function heldTransport() {
  const inner = memoryUploadTransport();
  const requests: {
    signal: AbortSignal | undefined;
    response: ReturnType<typeof deferred<RecordUploadStatus>>;
  }[] = [];
  const status = vi.fn((signal?: AbortSignal) => {
    const response = deferred<RecordUploadStatus>();
    requests.push({ signal, response });
    return response.promise;
  });
  const transport: RecordUploadTransport = {
    status,
    put: (args) => inner.put(args),
  };
  return { transport, status, requests };
}

function useObservedUpload(args: Args, seen: Seen[]) {
  const progress = useRecordUpload(args);
  useLayoutEffect(() => {
    seen.push({ args, progress });
  });
  return progress;
}

async function settleTimers(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

afterEach(() => vi.useRealTimers());

describe("useRecordUpload original lifecycle observations", () => {
  it("keeps real saved-segment feedback in layout and through active retry setup", async () => {
    const inner = memoryUploadTransport();
    const nextStatus = deferred<RecordUploadStatus>();
    const transport: RecordUploadTransport = {
      status: (signal) => inner.status(signal),
      put: (input) => inner.put(input),
    };
    const status = vi.spyOn(transport, "status");
    const args = initialArgs(transport);
    const sink = args.sink!;
    const ids = {
      sessionId: "room",
      takeIndex: 0,
      participantId: "p_a",
      segmentIndex: 0,
    };
    const path = keeperWavPath(ids);
    const wav = new Uint8Array(52);
    wav.set(pcmWavHeader(8));
    wav.fill(7, 44);
    await sink.write(path, wav);
    await sink.write(keeperMetaPath(path), keeperMetaBytes(ids));
    const seen: Seen[] = [];
    const { result, rerender, unmount } = renderHook(
      (input: Args) => useObservedUpload(input, seen),
      { initialProps: args },
    );
    await waitFor(() => expect(result.current.fileAck).toBe(true));
    expect(inner.puts).toBeGreaterThan(0);
    expect(result.current.segments).toEqual([
      { take: 0, segment: 0, state: "saved", chunks: null, landFailed: false },
    ]);
    const saved = result.current;
    status.mockImplementationOnce(() => nextStatus.promise);
    const retry = { ...args, retryNonce: 1 };
    rerender(retry);
    expect(seen.find((entry) => entry.args === retry)?.progress).toBe(saved);
    expect(result.current).toEqual({ ...saved, pending: true, error: null });
    expect(result.current.segments).toBe(saved.segments);
    unmount();
    await act(async () => {
      nextStatus.resolve({ segments: [] });
    });
  });

  it("retains failed history in layout, clears it at retry setup, then resets on disable", async () => {
    vi.useFakeTimers();
    const held = heldTransport();
    const args = initialArgs(held.transport);
    const seen: Seen[] = [];
    const { result, rerender, unmount } = renderHook(
      (input: Args) => useObservedUpload(input, seen),
      { initialProps: args },
    );
    expect(held.requests).toHaveLength(1);
    await act(async () => {
      held.requests[0]!.response.reject(new Error("Original status failure"));
    });
    expect(result.current.error).toBe("Original status failure");
    expect(result.current.pending).toBe(false);
    const failed = result.current;
    const retry = { ...args, retryNonce: 1 };
    rerender(retry);
    expect(seen.find((entry) => entry.args === retry)?.progress).toBe(failed);
    expect(held.requests[0]!.signal?.aborted).toBe(true);
    expect(held.requests).toHaveLength(2);
    expect(result.current.pending).toBe(true);
    expect(result.current.error).toBeNull();
    const pending = result.current;
    const disabled = { ...retry, enabled: false };
    rerender(disabled);
    expect(seen.find((entry) => entry.args === disabled)?.progress).toBe(
      pending,
    );
    expect(held.requests[1]!.signal?.aborted).toBe(true);
    expect(result.current).toMatchObject({
      pending: false,
      uploading: false,
      acked: 0,
      total: 0,
      error: null,
      segments: [],
    });
    unmount();
    await act(async () => {
      held.requests[1]!.response.resolve({ segments: [] });
    });
  });

  it.each([
    "enabled",
    "roomState",
    "captureSettled",
    "sessionId",
    "takeIndex",
    "participantId",
    "transport",
    "sink",
    "retryNonce",
  ] as const)("retires the acquired request when %s changes", async (key) => {
    vi.useFakeTimers();
    const first = heldTransport();
    const second = heldTransport();
    const args = initialArgs(first.transport);
    const replacements: Args = {
      ...args,
      enabled: false,
      roomState: "stopped",
      captureSettled: true,
      sessionId: "next-room",
      takeIndex: 1,
      participantId: "p_b",
      transport: second.transport,
      sink: new MemorySink(),
      retryNonce: 1,
    };
    const { rerender, unmount } = renderHook(
      (input: Args) => useRecordUpload(input),
      { initialProps: args },
    );
    expect(first.requests).toHaveLength(1);
    const changed = { ...args, [key]: replacements[key] };
    rerender(changed);
    expect(first.requests[0]!.signal?.aborted).toBe(true);
    const expectedRequests = key === "enabled" ? 1 : 2;
    expect(first.requests.length + second.requests.length).toBe(
      expectedRequests,
    );
    unmount();
    await act(async () => {
      for (const request of [...first.requests, ...second.requests]) {
        request.response.resolve({ segments: [] });
      }
    });
  });

  it.each(["sessionId", "participantId", "transport", "sink"] as const)(
    "clears prior feedback when the %s prerequisite is removed",
    async (key) => {
      vi.useFakeTimers();
      const held = heldTransport();
      const args = initialArgs(held.transport);
      const seen: Seen[] = [];
      const { result, rerender, unmount } = renderHook(
        (input: Args) => useObservedUpload(input, seen),
        { initialProps: args },
      );
      await act(async () => {
        held.requests[0]!.response.reject(new Error("Retained original error"));
      });
      expect(result.current.error).toBe("Retained original error");
      const failed = result.current;
      const missing = { ...args, [key]: null };
      rerender(missing);
      expect(seen.find((entry) => entry.args === missing)?.progress).toBe(
        failed,
      );
      expect(held.requests[0]!.signal?.aborted).toBe(true);
      expect(held.requests).toHaveLength(1);
      expect(result.current).toMatchObject({
        pending: false,
        error: null,
        segments: [],
      });
      unmount();
    },
  );

  it("keeps both retired ABA requests out of the live third request", async () => {
    vi.useFakeTimers();
    const held = heldTransport();
    const args = initialArgs(held.transport);
    const { result, rerender, unmount } = renderHook(
      (input: Args) => useRecordUpload(input),
      { initialProps: args },
    );
    rerender({ ...args, sessionId: "other-room" });
    rerender({ ...args });
    expect(held.requests).toHaveLength(3);
    expect(held.requests.map((request) => request.signal?.aborted)).toEqual([
      true,
      true,
      false,
    ]);
    const current = result.current;
    await act(async () => {
      held.requests[0]!.response.resolve({ segments: [] });
      held.requests[1]!.response.reject(new Error("Retired middle room"));
    });
    expect(result.current).toBe(current);
    expect(result.current.pending).toBe(true);
    await act(async () => {
      held.requests[2]!.response.resolve({ segments: [] });
    });
    expect(result.current.pending).toBe(false);
    expect(result.current.error).toBeNull();
    unmount();
  });

  it("keeps an equal-args request and its 2000ms deadline", async () => {
    vi.useFakeTimers();
    const held = heldTransport();
    const args = initialArgs(held.transport);
    const { rerender, unmount } = renderHook(
      (input: Args) => useRecordUpload(input),
      { initialProps: args },
    );
    await act(async () => {
      held.requests[0]!.response.resolve({ segments: [] });
    });
    await settleTimers(1000);
    rerender({ ...args });
    expect(held.requests).toHaveLength(1);
    expect(held.requests[0]!.signal?.aborted).toBe(false);
    await settleTimers(999);
    expect(held.requests).toHaveLength(1);
    await settleTimers(1);
    expect(held.requests).toHaveLength(2);
    unmount();
    await act(async () => {
      held.requests[1]!.response.resolve({ segments: [] });
    });
  });

  it.each(["resolve", "reject"] as const)(
    "does not publish a held old status %s after replacement",
    async (outcome) => {
      vi.useFakeTimers();
      const first = heldTransport();
      const next = heldTransport();
      const args = initialArgs(first.transport);
      const { result, rerender, unmount } = renderHook(
        (input: Args) => useRecordUpload(input),
        { initialProps: args },
      );
      rerender({ ...args, transport: next.transport });
      expect(first.requests[0]!.signal?.aborted).toBe(true);
      expect(next.requests).toHaveLength(1);
      const currentPending = result.current;
      await act(async () => {
        if (outcome === "resolve") {
          first.requests[0]!.response.resolve({ segments: [] });
        } else {
          first.requests[0]!.response.reject(new Error("Retired request"));
        }
      });
      expect(result.current).toBe(currentPending);
      expect(result.current.pending).toBe(true);
      expect(result.current.error).toBeNull();
      await act(async () => {
        next.requests[0]!.response.resolve({ segments: [] });
      });
      expect(result.current.pending).toBe(false);
      expect(result.current.error).toBeNull();
      unmount();
    },
  );

  it("retires the replayed request and polls only the live StrictMode acquisition", async () => {
    vi.useFakeTimers();
    const held = heldTransport();
    const args = initialArgs(held.transport);
    const { result, unmount } = renderHook(() => useRecordUpload(args), {
      wrapper: StrictMode,
    });
    expect(held.requests).toHaveLength(2);
    expect(held.requests[0]!.signal?.aborted).toBe(true);
    expect(held.requests[1]!.signal?.aborted).toBe(false);
    await act(async () => {
      held.requests[0]!.response.reject(new Error("Replay retired"));
      held.requests[1]!.response.resolve({ segments: [] });
    });
    expect(result.current.error).toBeNull();
    expect(result.current.pending).toBe(false);
    await settleTimers(1999);
    expect(held.requests).toHaveLength(2);
    await settleTimers(1);
    expect(held.requests).toHaveLength(3);
    unmount();
    expect(held.requests[2]!.signal?.aborted).toBe(true);
    await act(async () => {
      held.requests[2]!.response.resolve({ segments: [] });
    });
    await settleTimers(4000);
    expect(held.requests).toHaveLength(3);
  });
});
