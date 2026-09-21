import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ByteSink, keeperWavPath, MemorySink } from "../keeper/store";
import { memoryUploadTransport, type RecordUploadTransport } from "./transport";
import { leaveBlocked, useRecordUpload } from "./useRecordUpload";

function wavWithPcm(bytes: number): Uint8Array {
  const wav = new Uint8Array(44 + bytes);
  wav.fill(7, 44);
  return wav;
}

function sinkForTakes(): ByteSink {
  const wav = wavWithPcm(8);
  return {
    async write() {
      return;
    },
    async read(path: string) {
      if (path.endsWith(".json")) {
        return new TextEncoder().encode(
          JSON.stringify({ joinOffsetMs: path.includes("/1/") ? 2000 : 0 }),
        );
      }
      if (path.includes("/0/") || path.includes("/1/")) {
        return wav;
      }
      return null;
    },
    async open() {
      return {
        async write() {
          return;
        },
        async close() {
          return;
        },
      };
    },
    async nextSegmentIndex(_sessionId, takeIndex) {
      return takeIndex <= 1 ? 1 : 0;
    },
    async remove() {
      return;
    },
  };
}

describe("useRecordUpload", () => {
  it("does not confirm landing when no local segment exists", async () => {
    const nextSegmentIndex = vi.fn(async () => 0);
    const transport = memoryUploadTransport();
    const sink = {
      ...sinkForTakes(),
      nextSegmentIndex,
    };
    const { result, unmount } = renderHook(() =>
      useRecordUpload({
        enabled: true,
        roomState: "stopped",
        captureSettled: true,
        sessionId: "room1",
        takeIndex: 0,
        participantId: "p_a",
        transport,
        sink,
      }),
    );
    await waitFor(() => {
      expect(nextSegmentIndex).toHaveBeenCalled();
      expect(result.current.pending).toBe(false);
    });
    expect(result.current.landed).toBe(false);
    unmount();
  });
  afterEach(() => vi.useRealTimers());

  it("pumps keepers from earlier takes, keyed by participant", async () => {
    const transport = memoryUploadTransport();
    const sink = sinkForTakes();
    const { result, unmount } = renderHook(() =>
      useRecordUpload({
        enabled: true,
        roomState: "stopped",
        captureSettled: true,
        sessionId: "room1",
        takeIndex: 1,
        participantId: "p_a",
        transport,
        sink,
      }),
    );
    await waitFor(() => {
      expect(result.current.fileAck).toBe(true);
    });
    expect(transport.puts).toBe(2);
    expect(transport.joinOffsets).toEqual([0, 2000]);
    const status = await transport.status();
    expect(
      status.segments.map((row) => row.take_index).sort((a, b) => a - b),
    ).toEqual([0, 1]);
    expect(status.segments.every((row) => row.participant_id === "p_a")).toBe(
      true,
    );
    unmount();
  });

  it("retains an abandoned partial and releases Leave after complete segments upload", async () => {
    const sink = new MemorySink();
    const ids = { sessionId: "room1", takeIndex: 0, participantId: "p_a" };
    const partialPath = keeperWavPath({ ...ids, segmentIndex: 0 });
    const completePath = keeperWavPath({ ...ids, segmentIndex: 1 });
    await sink.write(partialPath, wavWithPcm(8));
    await sink.write(completePath, wavWithPcm(8));
    await sink.write(
      completePath.replace(/\.wav$/, ".json"),
      new TextEncoder().encode(JSON.stringify({ joinOffsetMs: 4000 })),
    );
    const transport = memoryUploadTransport();
    const { result, rerender, unmount } = renderHook(
      ({ settled }) =>
        useRecordUpload({
          enabled: true,
          roomState: "stopped",
          captureSettled: settled,
          sessionId: ids.sessionId,
          takeIndex: ids.takeIndex,
          participantId: ids.participantId,
          transport,
          sink,
        }),
      { initialProps: { settled: false } },
    );
    await waitFor(() => expect(result.current.uploading).toBe(true));
    expect(leaveBlocked("stopped", result.current)).toBe(true);

    rerender({ settled: true });
    await waitFor(() =>
      expect(result.current.error).toContain("incomplete local keeper"),
    );
    expect(result.current.fileAck).toBe(false);
    expect(result.current.uploading).toBe(false);
    expect(leaveBlocked("stopped", result.current)).toBe(false);
    expect(await sink.read(partialPath)).not.toBeNull();
    expect(transport.joinOffsets).toContain(4000);
    unmount();
  });

  it("reports a missing file ACK as stalled, unblocks Leave, then retries on demand", async () => {
    vi.useFakeTimers();
    const memory = memoryUploadTransport();
    let allowFileAck = false;
    const transport: RecordUploadTransport = {
      async status(signal) {
        const response = await memory.status(signal);
        return {
          segments: response.segments.map((segment) => ({
            ...segment,
            file_ack: allowFileAck && segment.file_ack,
          })),
        };
      },
      async put(args) {
        const response = await memory.put(args);
        return { ...response, file_ack: allowFileAck && response.file_ack };
      },
    };
    const sink = sinkForTakes();
    const { result, rerender, unmount } = renderHook(
      ({ retryNonce }) =>
        useRecordUpload({
          enabled: true,
          roomState: "stopped",
        captureSettled: true,
          sessionId: "room1",
          takeIndex: 0,
          participantId: "p_a",
          transport,
          sink,
          retryNonce,
        }),
      { initialProps: { retryNonce: 0 } },
    );
    for (let tick = 0; tick < 6; tick += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
    }
    expect(result.current.acked).toBe(1);
    expect(result.current.total).toBe(1);
    expect(result.current.error).toMatch(/stalled/i);
    expect(leaveBlocked("stopped", result.current)).toBe(false);

    allowFileAck = true;
    rerender({ retryNonce: 1 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.fileAck).toBe(true);
    expect(result.current.error).toBeNull();
    unmount();
  });

  it("does not stall an open segment while the room is recording", async () => {
    vi.useFakeTimers();
    const sink = sinkForTakes();
    const transport: RecordUploadTransport = {
      async status() {
        return { segments: [] };
      },
      async put(args) {
        return {
          acked: true,
          take_index: args.takeIndex,
          participant_id: "p_a",
          segment_index: args.segmentIndex,
          part_seq: args.partSeq,
          file_ack: false,
        };
      },
    };
    const { result, unmount } = renderHook(() =>
      useRecordUpload({
        enabled: true,
        roomState: "recording",
        captureSettled: false,
        sessionId: "room1",
        takeIndex: 0,
        participantId: "p_a",
        transport,
        sink,
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    expect(result.current.error).toBeNull();
    unmount();
  });

  it("never calls an absent local segment uploaded after Stop", async () => {
    const sink = { ...sinkForTakes(), nextSegmentIndex: async () => 0 };
    const transport = memoryUploadTransport();
    const { result, unmount } = renderHook(() =>
      useRecordUpload({
        enabled: true,
        roomState: "stopped",
        captureSettled: true,
        sessionId: "room1",
        takeIndex: 2,
        participantId: "p_a",
        transport,
        sink,
      }),
    );
    await waitFor(() =>
      expect(result.current.error).toMatch(/no local keeper/i),
    );
    expect(result.current.fileAck).toBe(false);
    expect(leaveBlocked("stopped", result.current)).toBe(false);
    unmount();
  });
});

describe("leaveBlocked", () => {
  it("holds Leave only while a stopped take is still uploading", () => {
    expect(leaveBlocked("stopped", undefined)).toBe(false);
    expect(
      leaveBlocked("stopped", {
        acked: 0,
        total: 0,
        fileAck: false,
        landed: false,
        landFailed: false,
        uploading: false,
        pending: true,
        error: null,
      }),
    ).toBe(true);
    expect(
      leaveBlocked("stopped", {
        acked: 1,
        total: 3,
        fileAck: false,
        landed: false,
        landFailed: false,
        uploading: false,
        pending: false,
        error: "fail",
      }),
    ).toBe(false);
  });
});
