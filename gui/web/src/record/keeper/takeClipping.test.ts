import { describe, expect, it } from "vitest";
import { keeperMetaPath, keeperWavPath, MemorySink } from "./store";
import { readTakeClipping } from "./takeClipping";

const ids = { sessionId: "room", participantId: "p_g", takeIndex: 1 };

async function seed(
  sink: MemorySink,
  segmentIndex: number,
  meta: Record<string, unknown> | "pruned" | "garbage",
) {
  const wav = keeperWavPath({ ...ids, segmentIndex });
  await sink.write(wav, new Uint8Array(44));
  const body =
    meta === "garbage"
      ? "not json"
      : meta === "pruned"
        ? JSON.stringify({ pruned: true, ...ids, segmentIndex })
        : JSON.stringify({
            ...ids,
            segmentIndex,
            sampleRate: 48_000,
            joinOffsetMs: 0,
            samplesWritten: 4,
            complete: true,
            ...meta,
          });
  await sink.write(keeperMetaPath(wav), new TextEncoder().encode(body));
}

describe("readTakeClipping", () => {
  it("is known and empty when nothing was recorded", async () => {
    const out = await readTakeClipping(new MemorySink(), "room", "p_g", 1);
    expect(out).toEqual({ takeIndex: 1, regions: [], known: true });
  });

  it("offsets regions by each segment's join offset, sorted", async () => {
    const sink = new MemorySink();
    await seed(sink, 0, {
      joinOffsetMs: 0,
      clippingRegions: [{ startMs: 500, endMs: 600 }],
    });
    await seed(sink, 1, {
      joinOffsetMs: 10_000,
      clippingRegions: [{ startMs: 5, endMs: 9 }],
    });
    const out = await readTakeClipping(sink, "room", "p_g", 1);
    expect(out.known).toBe(true);
    expect(out.regions).toEqual([
      { segmentIndex: 0, startMs: 500, endMs: 600, segmentStartMs: 500 },
      { segmentIndex: 1, startMs: 10_005, endMs: 10_009, segmentStartMs: 5 },
    ]);
  });

  it.each([
    ["legacy (no regions)", {}],
    ["pending", { complete: false, clippingRegions: [] }],
    ["malformed regions", { clippingRegions: "x" }],
  ])("marks %s as unknown", async (_label, meta) => {
    const sink = new MemorySink();
    await seed(sink, 0, meta);
    expect((await readTakeClipping(sink, "room", "p_g", 1)).known).toBe(false);
  });

  it("marks unreadable metadata unknown and skips pruned markers", async () => {
    const sink = new MemorySink();
    await seed(sink, 0, "pruned");
    expect((await readTakeClipping(sink, "room", "p_g", 1)).known).toBe(true);
    await seed(sink, 1, "garbage");
    expect((await readTakeClipping(sink, "room", "p_g", 1)).known).toBe(false);
  });
});
