import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ByteSink } from "../keeper/store";
import { memoryUploadTransport } from "./transport";
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

  it("pumps keepers from earlier takes, keyed by participant", async () => {
    const transport = memoryUploadTransport();
    const sink = sinkForTakes();
    const { result, unmount } = renderHook(() =>
      useRecordUpload({
        enabled: true,
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
