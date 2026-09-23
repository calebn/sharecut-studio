import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pcmWavHeader } from "../../audio/wavHeader";
import {
  type ByteSink,
  keeperMetaPath,
  keeperWavPath,
  MemorySink,
} from "../keeper/store";
import { memoryUploadTransport, type RecordUploadTransport } from "./transport";
import {
  keeperCaptureSettled,
  leaveBlocked,
  useRecordUpload,
} from "./useRecordUpload";

function pendingMeta(
  ids: { sessionId: string; takeIndex: number; participantId: string },
  segmentIndex: number,
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      ...ids,
      segmentIndex,
      sampleRate: 48_000,
      joinOffsetMs: 0,
      samplesWritten: 0,
      complete: false,
    }),
  );
}

function wavWithPcm(bytes: number): Uint8Array {
  const wav = new Uint8Array(44 + bytes);
  wav.set(pcmWavHeader(bytes));
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
        const parts = path.split("/");
        return new TextEncoder().encode(
          JSON.stringify({
            sessionId: parts[1],
            takeIndex: Number(parts[2]),
            participantId: parts[3],
            segmentIndex: Number(parts[4]?.replace(/\.json$/, "")),
            sampleRate: 48_000,
            joinOffsetMs: path.includes("/1/") ? 2000 : 0,
            samplesWritten: 4,
            complete: true,
          }),
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
  it("reports a metadata-only crash without pretending the missing PCM can upload", async () => {
    const sink = new MemorySink();
    const path = keeperWavPath({
      sessionId: "room1",
      takeIndex: 0,
      participantId: "p_a",
      segmentIndex: 0,
    });
    await sink.write(
      keeperMetaPath(path),
      new TextEncoder().encode(
        JSON.stringify({
          sessionId: "room1",
          takeIndex: 0,
          participantId: "p_a",
          segmentIndex: 0,
          sampleRate: 48_000,
          joinOffsetMs: 0,
          samplesWritten: 0,
          complete: false,
        }),
      ),
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
    await waitFor(() =>
      expect(result.current.error).toMatch(/no committed PCM/i),
    );
    expect(result.current.recoverable).toBe(false);
    expect(result.current.uploading).toBe(false);
    expect(leaveBlocked("stopped", result.current)).toBe(false);
    unmount();
  });

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
      keeperMetaPath(completePath),
      new TextEncoder().encode(
        JSON.stringify({
          sessionId: "room1",
          takeIndex: 0,
          participantId: "p_a",
          segmentIndex: 1,
          sampleRate: 48_000,
          joinOffsetMs: 4000,
          samplesWritten: 4,
          complete: true,
        }),
      ),
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
    await waitFor(() => expect(result.current.pending).toBe(false));
    // Stop is still finalizing: Leave stays held until capture settles.
    expect(result.current.uploading).toBe(true);
    expect(leaveBlocked("stopped", result.current)).toBe(true);

    rerender({ settled: true });
    await waitFor(() =>
      expect(result.current.error).toContain("no readable recovery metadata"),
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
          ? new TextEncoder().encode(
              JSON.stringify({
                sessionId: "room1",
                takeIndex: 0,
                participantId: "p_a",
                segmentIndex: 1,
                sampleRate: 48_000,
                joinOffsetMs: 0,
                samplesWritten: 4,
                complete: true,
              }),
            )
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
});

describe("useRecordUpload finalization and recovery", () => {
  const ids = { sessionId: "room1", takeIndex: 0, participantId: "p_a" };

  function render(sink: ByteSink, state: string, settled: boolean) {
    const transport = memoryUploadTransport();
    return renderHook(
      ({ roomState, captureSettled }) =>
        useRecordUpload({
          enabled: true,
          roomState,
          captureSettled,
          ...ids,
          transport,
          sink,
        }),
      { initialProps: { roomState: state, captureSettled: settled } },
    );
  }

  it("holds Leave for a lone segment that Stop is still finalizing", async () => {
    const sink = new MemorySink();
    const path = keeperWavPath({ ...ids, segmentIndex: 0 });
    await sink.write(path, wavWithPcm(8));
    await sink.write(keeperMetaPath(path), pendingMeta(ids, 0));
    const { result, rerender, unmount } = render(sink, "stopped", false);
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.total).toBe(0);
    expect(result.current.error).toBeNull();
    expect(leaveBlocked("stopped", result.current)).toBe(true);

    rerender({ roomState: "stopped", captureSettled: true });
    await waitFor(() => expect(result.current.recoverable).toBe(true));
    expect(result.current.error).toMatch(/Recover it before uploading/);
    expect(leaveBlocked("stopped", result.current)).toBe(false);
    unmount();
  });

  it("never reads a pending WAV while the room is recording", async () => {
    const sink = new MemorySink();
    const path = keeperWavPath({ ...ids, segmentIndex: 0 });
    await sink.write(path, wavWithPcm(8));
    await sink.write(keeperMetaPath(path), pendingMeta(ids, 0));
    const readBlob = vi.spyOn(sink, "readBlob");
    const read = vi.spyOn(sink, "read");
    const { result, unmount } = render(sink, "recording", false);
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(readBlob).not.toHaveBeenCalled();
    expect(read.mock.calls.map(([p]) => p)).not.toContain(path);
    expect(result.current).toMatchObject({ uploading: false, error: null });
    unmount();
  });

  it("reports unrecoverable segments alongside a recoverable one", async () => {
    const sink = new MemorySink();
    const readable = keeperWavPath({ ...ids, segmentIndex: 0 });
    const empty = keeperWavPath({ ...ids, segmentIndex: 1 });
    await sink.write(readable, wavWithPcm(8));
    await sink.write(keeperMetaPath(readable), pendingMeta(ids, 0));
    await sink.write(empty, new Uint8Array());
    await sink.write(keeperMetaPath(empty), pendingMeta(ids, 1));
    const { result, unmount } = render(sink, "stopped", true);
    await waitFor(() => expect(result.current.recoverable).toBe(true));
    expect(result.current.error).toMatch(/Recover it before uploading/);
    expect(result.current.error).toMatch(/no committed PCM/);
    unmount();
  });

  it("reports a finalized keeper whose WAV disappeared", async () => {
    const sink = new MemorySink();
    const path = keeperWavPath({ ...ids, segmentIndex: 0 });
    await sink.write(
      keeperMetaPath(path),
      new TextEncoder().encode(
        JSON.stringify({
          ...ids,
          segmentIndex: 0,
          sampleRate: 48_000,
          joinOffsetMs: 0,
          samplesWritten: 4,
          complete: true,
        }),
      ),
    );
    const { result, unmount } = render(sink, "stopped", true);
    await waitFor(() =>
      expect(result.current.error).toMatch(/finalized local keeper is missing/),
    );
    unmount();
  });
});

describe("keeperCaptureSettled", () => {
  it("settles once capture stops, or when finalization latched a failure", () => {
    const idle = { recordingLocally: false, finalizing: false, error: null };
    expect(keeperCaptureSettled(idle)).toBe(true);
    expect(keeperCaptureSettled({ ...idle, recordingLocally: true })).toBe(
      false,
    );
    expect(keeperCaptureSettled({ ...idle, finalizing: true })).toBe(false);
    expect(
      keeperCaptureSettled({ ...idle, finalizing: true, error: "disk full" }),
    ).toBe(true);
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
        recoverable: false,
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
        recoverable: false,
        error: "fail",
      }),
    ).toBe(false);
  });
});
