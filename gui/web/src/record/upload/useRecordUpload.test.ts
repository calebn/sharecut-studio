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
    // Real timers let async hashing settle even on a slow CI runner.
    const setInterval = window.setInterval.bind(window);
    vi.spyOn(window, "setInterval").mockImplementation(
      (handler, _delay, ...args) =>
        setInterval(handler, 50, ...args) as unknown as ReturnType<
          typeof globalThis.setInterval
        >,
    );
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
    await waitFor(() => expect(result.current.error).toMatch(/stalled/i));
    expect(result.current.acked).toBe(1);
    expect(result.current.total).toBe(1);
    expect(result.current.error).toMatch(/stalled/i);
    expect(leaveBlocked("stopped", result.current)).toBe(false);

    allowFileAck = true;
    rerender({ retryNonce: 1 });
    await waitFor(() => expect(result.current.fileAck).toBe(true));
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

  it("uses the declared total for an assembled segment whose parts are gone", async () => {
    const wav = wavWithPcm(8);
    const sink: ByteSink = {
      async write() {
        return;
      },
      async read(path) {
        return path.endsWith("1.json")
          ? new TextEncoder().encode(JSON.stringify({ joinOffsetMs: 0 }))
          : path.endsWith(".json")
            ? null
            : wav;
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
      async nextSegmentIndex() {
        return 2;
      },
      async remove() {
        return;
      },
    };
    const transport: RecordUploadTransport = {
      async status() {
        return {
          segments: [
            {
              take_index: 0,
              participant_id: "p_a",
              segment_index: 0,
              acked_parts: [],
              expected_parts: 3,
              file_ack: true,
            },
          ],
        };
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
      expect(result.current).toMatchObject({ acked: 4, total: 4 });
    });
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

  it("reclaims a finalized WAV only after authoritative landing", async () => {
    const sink = new MemorySink();
    const wavPath = keeperWavPath({
      sessionId: "room1",
      takeIndex: 0,
      participantId: "p_a",
      segmentIndex: 0,
    });
    await sink.write(wavPath, wavWithPcm(8));
    await sink.write(
      wavPath.replace(/\.wav$/, ".json"),
      new TextEncoder().encode(JSON.stringify({ joinOffsetMs: 0 })),
    );
    const transport = memoryUploadTransport();
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
    await waitFor(() => expect(result.current.landed).toBe(true));
    await waitFor(async () => expect(await sink.read(wavPath)).toBeNull());
    expect(await sink.read(wavPath.replace(/\.wav$/, ".json"))).not.toBeNull();
    expect(await sink.nextSegmentIndex("room1", 0, "p_a")).toBe(1);
    unmount();
  });

  it("retains a finalized WAV when landing is not confirmed", async () => {
    const sink = new MemorySink();
    const wavPath = keeperWavPath({
      sessionId: "room1",
      takeIndex: 0,
      participantId: "p_a",
      segmentIndex: 0,
    });
    await sink.write(wavPath, wavWithPcm(8));
    await sink.write(
      wavPath.replace(/\.wav$/, ".json"),
      new TextEncoder().encode(JSON.stringify({ joinOffsetMs: 0 })),
    );
    const transport = memoryUploadTransport();
    const originalStatus = transport.status.bind(transport);
    transport.status = async () => {
      const status = await originalStatus();
      return {
        segments: status.segments.map((segment) => ({
          ...segment,
          landed: false,
          land_failed: true,
        })),
      };
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
    await waitFor(() => expect(result.current.landFailed).toBe(true));
    expect(await sink.read(wavPath)).not.toBeNull();
    unmount();
  });

  it("reclaims prior takes, protects the active take and missing metadata, and does not repeat cleanup", async () => {
    const sink = new MemorySink();
    const path = (takeIndex: number, segmentIndex: number) =>
      keeperWavPath({
        sessionId: "room1",
        takeIndex,
        participantId: "p_a",
        segmentIndex,
      });
    for (const [take, segment] of [
      [0, 0],
      [1, 0],
      [1, 1],
    ]) {
      const wavPath = path(take, segment);
      await sink.write(wavPath, wavWithPcm(8));
      if (segment === 0) {
        await sink.write(
          wavPath.replace(/\.wav$/, ".json"),
          new TextEncoder().encode("{}"),
        );
      }
    }
    const remove = vi.spyOn(sink, "remove");
    const transport: RecordUploadTransport = {
      async status() {
        return {
          segments: [
            [0, 0],
            [1, 0],
            [1, 1],
          ].map(([take, segment]) => ({
            take_index: take,
            segment_index: segment,
            participant_id: "p_a",
            acked_parts: [0],
            file_ack: true,
            landed: true,
          })),
        };
      },
      async put() {
        throw new Error("already landed");
      },
    };
    const { rerender, unmount } = renderHook(
      ({ roomState, captureSettled, retryNonce }) =>
        useRecordUpload({
          enabled: true,
          roomState,
          captureSettled,
          sessionId: "room1",
          takeIndex: 1,
          participantId: "p_a",
          transport,
          sink,
          retryNonce,
        }),
      {
        initialProps: {
          roomState: "recording",
          captureSettled: false,
          retryNonce: 0,
        },
      },
    );
    await waitFor(() => expect(remove).toHaveBeenCalledWith(path(0, 0)));
    expect(await sink.read(path(1, 0))).not.toBeNull();
    expect(await sink.read(path(1, 1))).not.toBeNull();

    rerender({ roomState: "stopped", captureSettled: true, retryNonce: 0 });
    await waitFor(() => expect(remove).toHaveBeenCalledWith(path(1, 0)));
    expect(await sink.read(path(1, 1))).not.toBeNull();
    expect(await sink.nextSegmentIndex("room1", 1, "p_a")).toBe(2);

    rerender({ roomState: "stopped", captureSettled: true, retryNonce: 1 });
    await waitFor(() => expect(remove).toHaveBeenCalledTimes(2));
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
