import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pcmWavHeader } from "../../audio/wavHeader";
import { keeperMetaBytes, seedPendingKeeper } from "../../test/keepers";
import { sha256Hex } from "../keeper/fingerprint";
import {
  holdKeeperReclaim,
  KEEPER_RECLAIM_MAX_FAILURES,
} from "../keeper/reclaim";
import {
  type ByteSink,
  keeperMetaPath,
  keeperWavPath,
  MemorySink,
  ORPHAN_KEEPER_RETENTION_MS,
} from "../keeper/store";
import { recoverLocalKeepers } from "./recovery";
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

const LANDED_WAV_LENGTH = 52;
let landedHash = "";
async function fingerprintForTestWav() {
  landedHash = await sha256Hex(wavWithPcm(8));
  return { fileSha256: landedHash, byteLength: LANDED_WAV_LENGTH };
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
  it("expires an old metadata-free WAV only after capture settles", async () => {
    const sink = new MemorySink();
    const path = keeperWavPath({
      sessionId: "room1",
      takeIndex: 0,
      participantId: "p_a",
      segmentIndex: 0,
    });
    await sink.write(path, wavWithPcm(8));
    sink.modified.set(path, Date.now() - ORPHAN_KEEPER_RETENTION_MS - 1);
    const transport = memoryUploadTransport();
    const { result, rerender, unmount } = renderHook(
      ({ roomState, captureSettled }) =>
        useRecordUpload({
          enabled: true,
          roomState,
          captureSettled,
          sessionId: "room1",
          takeIndex: 0,
          participantId: "p_a",
          transport,
          sink,
        }),
      { initialProps: { roomState: "recording", captureSettled: false } },
    );
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(await sink.read(path)).not.toBeNull();
    rerender({ roomState: "stopped", captureSettled: true });
    await waitFor(() =>
      expect(result.current.error).toMatch(/expired after seven days/),
    );
    expect(result.current.landed).toBe(false);
    expect(await sink.read(path)).toBeNull();
    expect(await sink.nextSegmentIndex("room1", 0, "p_a")).toBe(1);
    unmount();
  });
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
        return path.endsWith(".json")
          ? new TextEncoder().encode(
              JSON.stringify({
                sessionId: "room1",
                takeIndex: 0,
                participantId: "p_a",
                segmentIndex: path.endsWith("1.json") ? 1 : 0,
                sampleRate: 48_000,
                joinOffsetMs: 0,
                samplesWritten: 4,
                complete: true,
              }),
            )
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
      keeperMetaPath(wavPath),
      keeperMetaBytes(
        {
          sessionId: "room1",
          takeIndex: 0,
          participantId: "p_a",
        },
        true,
        await fingerprintForTestWav(),
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
    await waitFor(() => expect(result.current.landed).toBe(true));
    await waitFor(async () => expect(await sink.read(wavPath)).toBeNull());
    expect(await sink.read(wavPath.replace(/\.wav$/, ".json"))).not.toBeNull();
    expect(await sink.nextSegmentIndex("room1", 0, "p_a")).toBe(1);
    unmount();
  });

  it("retains a landed WAV and surfaces a mismatch when metadata is legacy", async () => {
    const sink = new MemorySink();
    const wavPath = keeperWavPath({
      sessionId: "room1",
      takeIndex: 0,
      participantId: "p_a",
      segmentIndex: 0,
    });
    await sink.write(wavPath, wavWithPcm(8));
    await sink.write(
      keeperMetaPath(wavPath),
      keeperMetaBytes(
        { sessionId: "room1", takeIndex: 0, participantId: "p_a" },
        undefined,
      ),
    );
    const transport: RecordUploadTransport = {
      async status() {
        return {
          segments: [
            {
              take_index: 0,
              segment_index: 0,
              participant_id: "p_a",
              acked_parts: [0],
              file_ack: true,
              landed: true,
              file_sha256: await sha256Hex(wavWithPcm(8)),
              byte_length: 52,
            },
          ],
        };
      },
      async put() {
        throw new Error("already landed");
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
    await waitFor(() => expect(result.current.reclaimMismatch).toBe(true));
    expect(result.current.landed).toBe(true);
    expect(await sink.read(wavPath)).not.toBeNull();
    unmount();
  });

  it("keeps a pending WAV even when the host reports it landed", async () => {
    const sink = new MemorySink();
    const ids = {
      sessionId: "room1",
      takeIndex: 0,
      participantId: "p_a",
    };
    const wavPath = keeperWavPath({ ...ids, segmentIndex: 0 });
    await sink.write(wavPath, wavWithPcm(8));
    await sink.write(keeperMetaPath(wavPath), pendingMeta(ids, 0));
    const remove = vi.spyOn(sink, "remove");
    const status = vi.fn(async () => ({
      segments: [
        {
          take_index: 0,
          participant_id: "p_a",
          segment_index: 0,
          acked_parts: [0],
          file_ack: true,
          landed: true,
        },
      ],
    }));
    const put = vi.fn(async () => {
      throw new Error("already landed");
    });
    const transport: RecordUploadTransport = {
      status,
      put,
    };
    const { result, unmount } = renderHook(() =>
      useRecordUpload({
        enabled: true,
        roomState: "stopped",
        captureSettled: true,
        ...ids,
        transport,
        sink,
      }),
    );
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(status).toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(await sink.read(wavPath)).not.toBeNull();
    expect(result.current).toMatchObject({
      fileAck: false,
      landed: false,
      recoverable: true,
      error: expect.stringMatching(/Recover it before uploading/),
    });
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
      keeperMetaPath(wavPath),
      keeperMetaBytes(
        {
          sessionId: "room1",
          takeIndex: 0,
          participantId: "p_a",
        },
        true,
        await fingerprintForTestWav(),
      ),
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
          keeperMetaPath(wavPath),
          keeperMetaBytes(
            {
              sessionId: "room1",
              takeIndex: take,
              participantId: "p_a",
              segmentIndex: segment,
            },
            true,
            await fingerprintForTestWav(),
          ),
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
            file_sha256: landedHash,
            byte_length: LANDED_WAV_LENGTH,
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

  async function landedKeeper(sink: MemorySink): Promise<string> {
    const wavPath = keeperWavPath({
      sessionId: "room1",
      takeIndex: 0,
      participantId: "p_a",
      segmentIndex: 0,
    });
    await sink.write(wavPath, wavWithPcm(8));
    await sink.write(
      keeperMetaPath(wavPath),
      keeperMetaBytes(
        {
          sessionId: "room1",
          takeIndex: 0,
          participantId: "p_a",
        },
        true,
        await fingerprintForTestWav(),
      ),
    );
    return wavPath;
  }

  function landedTransport(state: { dropRow: boolean }): RecordUploadTransport {
    return {
      async status() {
        return {
          segments: state.dropRow
            ? []
            : [
                {
                  take_index: 0,
                  segment_index: 0,
                  participant_id: "p_a",
                  acked_parts: [0],
                  file_ack: true,
                  landed: true,
                  file_sha256: landedHash,
                  byte_length: LANDED_WAV_LENGTH,
                },
              ],
        };
      },
      async put() {
        throw new Error("a reclaimed segment must not re-upload");
      },
    };
  }

  function stoppedHook(sink: ByteSink, transport: RecordUploadTransport) {
    return renderHook(() =>
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
  }

  it("does not stall on a reclaimed segment whose host row disappears", async () => {
    vi.useFakeTimers();
    const sink = new MemorySink();
    const wavPath = await landedKeeper(sink);
    const state = { dropRow: false };
    const { result, unmount } = stoppedHook(sink, landedTransport(state));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(await sink.read(wavPath)).toBeNull();
    // Host discards the landed take: its status row is tombstoned away.
    state.dropRow = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(result.current).toMatchObject({
      fileAck: true,
      landed: true,
      uploading: false,
      error: null,
    });
    expect(leaveBlocked("stopped", result.current)).toBe(false);
    unmount();
  });

  it("treats a reclaimed segment as landed after a reload without its row", async () => {
    vi.useFakeTimers();
    const sink = new MemorySink();
    const wavPath = await landedKeeper(sink);
    await sink.remove(wavPath);
    const { result, unmount } = stoppedHook(
      sink,
      landedTransport({ dropRow: true }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(result.current).toMatchObject({
      fileAck: true,
      landed: true,
      uploading: false,
      error: null,
    });
    unmount();
  });

  it("surfaces repeated reclaim failures and keeps the WAV", async () => {
    vi.useFakeTimers();
    const sink = new MemorySink();
    const wavPath = await landedKeeper(sink);
    const remove = vi
      .spyOn(sink, "remove")
      .mockRejectedValue(
        new DOMException("locked", "NoModificationAllowedError"),
      );
    const { result, unmount } = stoppedHook(
      sink,
      landedTransport({ dropRow: false }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.reclaimFailed).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(remove).toHaveBeenCalledTimes(KEEPER_RECLAIM_MAX_FAILURES);
    expect(result.current.reclaimFailed).toBe(true);
    expect(result.current.landed).toBe(true);
    expect(await sink.read(wavPath)).not.toBeNull();
    unmount();
  });

  it("pauses reclaim while a recovery download holds the sink", async () => {
    vi.useFakeTimers();
    const sink = new MemorySink();
    const wavPath = await landedKeeper(sink);
    const release = await holdKeeperReclaim(sink);
    const { unmount } = stoppedHook(sink, landedTransport({ dropRow: false }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    expect(await sink.read(wavPath)).not.toBeNull();
    release();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(await sink.read(wavPath)).toBeNull();
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

  it("uploads a recovered partial, reclaims it only after landing, and keeps its identity", async () => {
    const sink = new MemorySink();
    const path = await seedPendingKeeper(sink, ids, [1, 0, 2, 0, 3]);
    const remove = vi.spyOn(sink, "remove");
    const { result, rerender, unmount } = render(sink, "stopped", true);
    await waitFor(() => expect(result.current.recoverable).toBe(true));
    // Pending (complete:false) metadata never allows reclaim or upload.
    expect(remove).not.toHaveBeenCalled();
    expect(result.current.total).toBe(0);

    await expect(
      recoverLocalKeepers(sink, ids.sessionId, ids.participantId, 0),
    ).resolves.toEqual({ recovered: 1, trimmed: 1 });
    rerender({ roomState: "stopped", captureSettled: true });
    await waitFor(() => expect(result.current.landed).toBe(true), {
      timeout: 5_000,
    });
    await waitFor(() => expect(remove).toHaveBeenCalledWith(path));
    expect(await sink.read(path)).toBeNull();
    const meta = await sink.read(keeperMetaPath(path));
    expect(JSON.parse(new TextDecoder().decode(meta!))).toMatchObject({
      complete: true,
      samplesWritten: 2,
    });
    expect(
      await sink.nextSegmentIndex(ids.sessionId, 0, ids.participantId),
    ).toBe(1);
    await expect(
      recoverLocalKeepers(sink, ids.sessionId, ids.participantId, 0),
    ).resolves.toEqual({ recovered: 0, trimmed: 0 });
    expect(result.current.error).toBeNull();
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
        reclaimFailed: false,
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
        reclaimFailed: false,
        uploading: false,
        pending: false,
        recoverable: false,
        error: "fail",
      }),
    ).toBe(false);
  });
});
