import { describe, expect, it } from "vitest";
import { uploadKeeperWav } from "../upload/pump";
import { inspectKeeperRecovery } from "../upload/recovery";
import { memoryUploadTransport } from "../upload/transport";
import { KEEPER_CLIP_THRESHOLD, KEEPER_SAMPLE_RATE } from "./pcm";
import type { KeeperGate } from "./segments";
import { type KeeperClipEvent, KeeperSession } from "./session";
import { keeperMetaPath, keeperWavPath, MemorySink } from "./store";
import { readTakeClipping } from "./takeClipping";

const ids = { sessionId: "cool-room", participantId: "p_g" };
const CHUNK = 128;
const rate = KEEPER_SAMPLE_RATE;

function gate(overrides: Partial<KeeperGate> = {}): KeeperGate & typeof ids {
  return {
    ...ids,
    role: "guest",
    consented: true,
    roomState: "recording",
    takeIndex: 0,
    recordingMs: 0,
    streamAvailable: true,
    muted: false,
    ...overrides,
  };
}

/** Push `seconds` of a constant level in 128-frame chunks, like the worklet. */
function pushLevel(session: KeeperSession, level: number, seconds: number) {
  const total = Math.round(seconds * rate);
  for (let done = 0; done < total; done += CHUNK) {
    session.push(
      new Float32Array(Math.min(CHUNK, total - done)).fill(level),
      rate,
    );
  }
}

/** Independent oracle: hot spans read back from the written WAV bytes. */
function expectedSpansMs(
  wav: Uint8Array,
): { startMs: number; endMs: number }[] {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const spans: { first: number; last: number }[] = [];
  const mergeSamples = rate; // hits less than 1 s apart merge
  const count = (wav.byteLength - 44) / 2;
  for (let i = 0; i < count; i++) {
    const v = Math.abs(view.getInt16(44 + i * 2, true)) / 32768;
    if (v < KEEPER_CLIP_THRESHOLD) continue;
    const tail = spans[spans.length - 1];
    if (tail && i - tail.last <= mergeSamples) tail.last = i;
    else spans.push({ first: i, last: i });
  }
  return spans.map((s) => ({
    startMs: Math.floor((s.first * 1000) / rate),
    endMs: Math.ceil(((s.last + 1) * 1000) / rate),
  }));
}

describe("clip capture through a real KeeperSession", () => {
  it("persists regions matching the written WAV and rebuilds them on reload", async () => {
    const sink = new MemorySink();
    const events: KeeperClipEvent[] = [];
    const session = new KeeperSession(sink, undefined, {
      onClipping: (e) => events.push(e),
    });
    await session.apply(gate());
    pushLevel(session, 0.3, 2);
    await session.flush();
    pushLevel(session, 0.95, 0.2);
    pushLevel(session, 0.3, 0.5);
    pushLevel(session, 0.95, 0.1); // merges with the previous burst
    pushLevel(session, 0.3, 3);
    pushLevel(session, 0.95, 0.05); // no flush: lands across an in-flight write
    pushLevel(session, 0.3, 0.5);
    await session.dispose();

    const wavPath = keeperWavPath({ ...ids, takeIndex: 0, segmentIndex: 0 });
    const wav = await sink.read(wavPath);
    const meta = JSON.parse(
      new TextDecoder().decode(
        (await sink.read(keeperMetaPath(wavPath))) ?? new Uint8Array(),
      ),
    );
    const expected = expectedSpansMs(wav ?? new Uint8Array());
    expect(expected).toHaveLength(2);
    expect(meta.clippingRegions).toHaveLength(2);
    meta.clippingRegions.forEach(
      (r: { startMs: number; endMs: number }, i: number) => {
        expect(
          Math.abs(r.startMs - (expected[i]?.startMs ?? -99)),
        ).toBeLessThanOrEqual(1);
        expect(
          Math.abs(r.endMs - (expected[i]?.endMs ?? -99)),
        ).toBeLessThanOrEqual(1);
      },
    );
    // The first region opens and then grows by >= 250 ms (merged burst); the second opens.
    expect(events.filter((e) => e.regions.length === 1)).toHaveLength(2);
    expect(events.at(-1)?.regions).toHaveLength(2);

    const take = await readTakeClipping(sink, "cool-room", "p_g", 0);
    expect(take.known).toBe(true);
    expect(take.regions.map((r) => r.startMs)).toEqual(
      meta.clippingRegions.map((r: { startMs: number }) => r.startMs),
    );
  });

  it("offsets later segments by their join offset", async () => {
    const sink = new MemorySink();
    const session = new KeeperSession(sink);
    await session.apply(gate());
    pushLevel(session, 0.3, 0.5);
    await session.apply(gate({ roomState: "paused" }));
    await session.apply(gate({ recordingMs: 10_000 }));
    pushLevel(session, 0.95, 0.1);
    await session.dispose();
    const take = await readTakeClipping(sink, "cool-room", "p_g", 0);
    expect(take.regions).toHaveLength(1);
    expect(take.regions[0]?.segmentIndex).toBe(1);
    expect(take.regions[0]?.startMs).toBeGreaterThanOrEqual(10_000);
    expect(take.regions[0]?.segmentStartMs).toBe(0);
  });

  it("records no regions while muted", async () => {
    const sink = new MemorySink();
    const session = new KeeperSession(sink);
    await session.apply(gate({ muted: true }));
    pushLevel(session, 0.99, 1);
    await session.dispose();
    const take = await readTakeClipping(sink, "cool-room", "p_g", 0);
    expect(take).toMatchObject({ regions: [], known: true });
  });

  it("hands the stored regions to recovery and sends them on the final part only", async () => {
    const sink = new MemorySink();
    const session = new KeeperSession(sink);
    await session.apply(gate());
    // 65 s in one-second pushes so the WAV spans three upload parts.
    for (let second = 0; second < 65; second++) {
      session.push(
        new Float32Array(rate).fill(second === 40 ? 0.95 : 0.3),
        rate,
      );
      if (second % 5 === 4) await session.flush();
    }
    await session.dispose();
    const wavPath = keeperWavPath({ ...ids, takeIndex: 0, segmentIndex: 0 });
    const recovery = await inspectKeeperRecovery(sink, wavPath);
    expect(recovery.kind).toBe("complete");
    if (recovery.kind !== "complete") return;
    expect(recovery.clippingRegions).toEqual([
      { startMs: 40_000, endMs: 41_000 },
    ]);
    const transport = memoryUploadTransport();
    await uploadKeeperWav({
      wav: (await sink.read(wavPath)) ?? new Uint8Array(),
      takeIndex: 0,
      segmentIndex: 0,
      transport,
      ackedParts: [],
      fileAck: false,
      joinOffsetMs: recovery.joinOffsetMs,
      clippingRegions: recovery.clippingRegions,
    });
    expect(transport.puts).toBe(3);
    expect(transport.clippingRegions).toEqual([
      undefined,
      undefined,
      [{ startMs: 40_000, endMs: 41_000 }],
    ]);
  });
});
