import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TakeClipping } from "./keeper/clipRegions";
import { keeperMetaPath, keeperWavPath, MemorySink } from "./keeper/store";
import { useTakeClipping } from "./useTakeClipping";

const live: TakeClipping = {
  takeIndex: 0,
  known: true,
  regions: [{ segmentIndex: 0, startMs: 1, endMs: 5, segmentStartMs: 1 }],
};

async function seedStored(sink: MemorySink) {
  const ids = { sessionId: "room", participantId: "p_g", takeIndex: 0 };
  const wav = keeperWavPath({ ...ids, segmentIndex: 0 });
  await sink.write(wav, new Uint8Array(44));
  await sink.write(
    keeperMetaPath(wav),
    new TextEncoder().encode(
      JSON.stringify({
        ...ids,
        segmentIndex: 0,
        sampleRate: 48_000,
        joinOffsetMs: 0,
        samplesWritten: 4,
        complete: true,
        clippingRegions: [{ startMs: 200, endMs: 300 }],
      }),
    ),
  );
}

const base = {
  sessionId: "room",
  participantId: "p_g",
  takeIndex: 0,
  captureSettled: true,
  live: null as TakeClipping | null,
};

describe("useTakeClipping", () => {
  it("returns the live state while recording or paused", () => {
    const sink = new MemorySink();
    const { result, rerender } = renderHook(
      (roomState: "recording" | "paused") =>
        useTakeClipping({ ...base, sink, roomState, live }),
      { initialProps: "recording" as "recording" | "paused" },
    );
    expect(result.current).toBe(live);
    rerender("paused");
    expect(result.current).toBe(live);
  });

  it("ignores live state from another take", () => {
    const { result } = renderHook(() =>
      useTakeClipping({
        ...base,
        sink: new MemorySink(),
        roomState: "recording",
        takeIndex: 1,
        live,
      }),
    );
    expect(result.current).toBeNull();
  });

  it("rebuilds from OPFS metadata once stopped, as after a reload", async () => {
    const sink = new MemorySink();
    await seedStored(sink);
    const { result } = renderHook(() =>
      useTakeClipping({ ...base, sink, roomState: "stopped" }),
    );
    await waitFor(() => expect(result.current?.regions).toHaveLength(1));
    expect(result.current?.regions[0]?.startMs).toBe(200);
    expect(result.current?.known).toBe(true);
  });

  it("waits for the keeper to settle and is null otherwise", async () => {
    const sink = new MemorySink();
    await seedStored(sink);
    const { result, rerender } = renderHook(
      (settled: boolean) =>
        useTakeClipping({
          ...base,
          sink,
          roomState: "stopped",
          captureSettled: settled,
          live,
        }),
      { initialProps: false },
    );
    expect(result.current).toBeNull();
    rerender(true);
    await waitFor(() => expect(result.current?.regions[0]?.startMs).toBe(200));
  });

  it("is null in the lobby", () => {
    const { result } = renderHook(() =>
      useTakeClipping({
        ...base,
        sink: new MemorySink(),
        roomState: "lobby",
        live,
      }),
    );
    expect(result.current).toBeNull();
  });
});
