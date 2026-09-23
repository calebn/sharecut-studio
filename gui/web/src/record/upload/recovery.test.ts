import { Blob as NodeBlob } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseWavHeader, pcmWavHeader } from "../../audio/wavHeader";
import { KEEPER_SAMPLE_RATE } from "../keeper/pcm";
import { KeeperSession } from "../keeper/session";
import {
  type ByteSink,
  keeperMetaPath,
  keeperWavPath,
  MemorySink,
} from "../keeper/store";
import {
  downloadLocalKeeper,
  downloadLocalKeepers,
  inspectKeeperRecovery,
  recoverKeeperSegment,
  recoverLocalKeepers,
} from "./recovery";

beforeEach(() => vi.stubGlobal("Blob", NodeBlob));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("downloadLocalKeepers", () => {
  it.each(["p_host", "p_guest"])(
    "exports every retained take and segment for %s without deleting OPFS",
    async (participantId) => {
      vi.useFakeTimers();
      const urls: string[] = [];
      const blobs: Blob[] = [];
      const revokeObjectURL = vi.fn();
      const NativeURL = URL;
      class DownloadURL extends NativeURL {
        static createObjectURL(blob: Blob) {
          const url = `blob:keeper-${urls.length}`;
          urls.push(url);
          blobs.push(blob);
          return url;
        }
        static revokeObjectURL = revokeObjectURL;
      }
      vi.stubGlobal("URL", DownloadURL);
      const filenames: string[] = [];
      vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
        function (this: HTMLAnchorElement) {
          filenames.push(this.download);
        },
      );
      const sink = new MemorySink();
      const paths = [
        [0, 0],
        [0, 1],
        [1, 0],
      ];
      for (const [takeIndex, segmentIndex] of paths) {
        await sink.write(
          keeperWavPath({
            sessionId: "room1",
            participantId,
            takeIndex,
            segmentIndex,
          }),
          new Uint8Array([1, 2, 3]),
        );
      }
      const remove = vi.spyOn(sink, "remove");
      await downloadLocalKeepers(sink, "room1", participantId, 1);
      expect(filenames).toEqual([`keepers-${participantId}.zip`]);
      expect(blobs[0]?.type).toBe("application/zip");
      const archive = new TextDecoder("latin1").decode(
        await blobs[0]!.arrayBuffer(),
      );
      for (const name of [
        "keeper-0-0.wav",
        "keeper-0-1.wav",
        "keeper-1-0.wav",
      ]) {
        expect(archive).toContain(name);
      }
      expect(remove).not.toHaveBeenCalled();
      await vi.runAllTimersAsync();
      expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    },
  );

  it("reports a missing local copy rather than silently succeeding", async () => {
    await expect(
      downloadLocalKeepers(new MemorySink(), "room1", "p_guest", 0),
    ).rejects.toThrow("No local keeper copy");
  });

  it("exports surviving sparse segments before reporting missing copies", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:keeper"),
      revokeObjectURL: vi.fn(),
    });
    const filenames: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      filenames.push(this.download);
    });
    const sink = new MemorySink();
    for (const [takeIndex, segmentIndex] of [
      [0, 0],
      [0, 2],
      [1, 0],
    ]) {
      await sink.write(
        keeperWavPath({
          sessionId: "room1",
          participantId: "p_guest",
          takeIndex,
          segmentIndex,
        }),
        new Uint8Array([1, 2, 3]),
      );
    }
    await expect(
      downloadLocalKeepers(sink, "room1", "p_guest", 1),
    ).rejects.toThrow("Downloaded 3 local keeper copies; 1 missing segment");
    expect(filenames).toEqual(["keepers-p_guest.zip"]);
    await vi.runAllTimersAsync();
  });

  it("downloads a native OPFS File without reading its bytes", async () => {
    vi.useFakeTimers();
    const file = new File(["wav"], "keeper.wav", { type: "audio/wav" });
    const createObjectURL = vi.fn(() => "blob:keeper");
    vi.stubGlobal("URL", {
      createObjectURL,
      revokeObjectURL: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      () => undefined,
    );
    const read = vi.fn(async () => {
      throw new Error("bytes should not be read");
    });
    const sink = {
      read,
      readBlob: async () => file,
    } as unknown as ByteSink;
    expect(await downloadLocalKeeper(sink, "keeper.wav", "keeper.wav")).toBe(
      true,
    );
    expect(createObjectURL).toHaveBeenCalledWith(file);
    expect(read).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
  });
});

const META = {
  sessionId: "room1",
  participantId: "p_guest",
  takeIndex: 2,
  segmentIndex: 3,
  sampleRate: 48_000,
  joinOffsetMs: 1250,
  samplesWritten: 0,
  complete: false,
};

async function writeRawMeta(
  sink: ByteSink,
  wavPath: string,
  meta: Record<string, unknown>,
): Promise<void> {
  await sink.write(
    keeperMetaPath(wavPath),
    new TextEncoder().encode(JSON.stringify(meta)),
  );
}

function wavBytes(declared: number, pcm: number[]): Uint8Array {
  const wav = new Uint8Array(44 + pcm.length);
  wav.set(pcmWavHeader(declared), 0);
  wav.set(pcm, 44);
  return wav;
}

async function inspectAndRecover(sink: ByteSink, wavPath: string) {
  const status = await inspectKeeperRecovery(sink, wavPath);
  if (status.kind !== "recoverable") {
    throw new Error(`expected recoverable, got ${status.kind}`);
  }
  await recoverKeeperSegment(sink, wavPath, status.plan);
  return status.plan;
}

/** A sink with neither readBlob nor rewriteHeader (full-read fallback). */
function plainSink(inner: MemorySink): ByteSink {
  return {
    write: (p, b) => inner.write(p, b),
    read: (p) => inner.read(p),
    remove: (p) => inner.remove(p),
    open: (p) => inner.open(p),
    nextSegmentIndex: (s, t, p) => inner.nextSegmentIndex(s, t, p),
  };
}

describe("keeper recovery", () => {
  const path = keeperWavPath({
    sessionId: "room1",
    participantId: "p_guest",
    takeIndex: 2,
    segmentIndex: 3,
  });

  it("restores a new capture cursor after a readable interrupted segment", async () => {
    const sink = new MemorySink();
    const first = new KeeperSession(sink);
    const gate = {
      sessionId: "room1",
      participantId: "p_guest",
      role: "guest" as const,
      consented: true as const,
      roomState: "recording" as const,
      takeIndex: 2,
      recordingMs: 1250,
      streamAvailable: true,
      muted: false,
    };
    await first.apply(gate);
    first.push(new Float32Array([0.25, -0.25]), KEEPER_SAMPLE_RATE);
    await first.flush();
    // Simulate a tab crash: the first session never finalizes its open WAV.
    const interrupted = keeperWavPath({ ...gate, segmentIndex: 0 });
    const retainedPcm = (await sink.read(interrupted))!.slice(44);
    const restored = new KeeperSession(sink);
    await restored.restoreCursor("room1", 2, "p_guest");
    await inspectAndRecover(sink, interrupted);
    expect(Array.from((await sink.read(interrupted))!.slice(44))).toEqual(
      Array.from(retainedPcm),
    );
    await restored.apply({ ...gate, recordingMs: 2250 });
    await restored.dispose();
    expect(restored.files[0]?.segmentIndex).toBe(1);
    expect((await sink.read(interrupted))!.length).toBe(
      44 + retainedPcm.length,
    );
  });

  it("recovers readable pending PCM while preserving the recorded join offset", async () => {
    const sink = new MemorySink();
    const pcm = [1, 0, 2, 0, 3, 0, 4, 0];
    await sink.write(path, wavBytes(0, pcm));
    await writeRawMeta(sink, path, META);
    const read = vi.spyOn(sink, "read");
    const plan = await inspectAndRecover(sink, path);
    expect(plan).toMatchObject({ pcmBytes: 8, trimmedBytes: 0 });
    // Header-only probe and in-place header patch: the WAV is never read whole.
    expect(read.mock.calls.map(([p]) => p)).not.toContain(path);
    const wav = await sink.read(path);
    expect(parseWavHeader(wav!.buffer).dataSize).toBe(pcm.length);
    expect(Array.from(wav!.subarray(44))).toEqual(pcm);
    const meta = JSON.parse(
      new TextDecoder().decode((await sink.read(keeperMetaPath(path)))!),
    ) as { joinOffsetMs: number; samplesWritten: number; complete: boolean };
    expect(meta).toMatchObject({
      joinOffsetMs: 1250,
      samplesWritten: 4,
      complete: true,
    });
    expect(await inspectKeeperRecovery(sink, path)).toEqual({
      kind: "complete",
      joinOffsetMs: 1250,
    });
  });

  it("falls back to a full rewrite on sinks without header patching", async () => {
    const inner = new MemorySink();
    const sink = plainSink(inner);
    await sink.write(path, wavBytes(0, [1, 0, 2, 0, 9]));
    await writeRawMeta(sink, path, META);
    const plan = await inspectAndRecover(sink, path);
    expect(plan).toMatchObject({ pcmBytes: 4, trimmedBytes: 1 });
    const wav = (await sink.read(path))!;
    expect(wav.length).toBe(48);
    expect(parseWavHeader(wav.buffer).dataSize).toBe(4);
  });

  it("refuses a fallback rewrite when the WAV shrank after inspection", async () => {
    const inner = new MemorySink();
    const sink = plainSink(inner);
    await sink.write(path, wavBytes(0, [1, 0, 2, 0]));
    await writeRawMeta(sink, path, META);
    const status = await inspectKeeperRecovery(sink, path);
    if (status.kind !== "recoverable") throw new Error("expected recoverable");
    await sink.write(path, wavBytes(0, [1, 0]));
    await expect(recoverKeeperSegment(sink, path, status.plan)).rejects.toThrow(
      /changed during recovery/,
    );
  });

  it("does not probe a pending WAV while capture may still be writing it", async () => {
    const sink = new MemorySink();
    await sink.write(path, wavBytes(0, [1, 0]));
    await writeRawMeta(sink, path, META);
    const readBlob = vi.spyOn(sink, "readBlob");
    const read = vi.spyOn(sink, "read");
    expect(
      await inspectKeeperRecovery(sink, path, { inspectPending: false }),
    ).toEqual({ kind: "pending" });
    expect(readBlob).not.toHaveBeenCalled();
    expect(read.mock.calls.map(([p]) => p)).toEqual([keeperMetaPath(path)]);
  });

  it("treats closed keepers from older clients (no complete flag) as complete", async () => {
    const sink = new MemorySink();
    await sink.write(path, wavBytes(4, [1, 0, 2, 0]));
    const { complete: _omit, ...legacy } = { ...META, samplesWritten: 2 };
    await writeRawMeta(sink, path, legacy);
    expect(await inspectKeeperRecovery(sink, path)).toEqual({
      kind: "complete",
      joinOffsetMs: 1250,
    });
    // A legacy record whose header disagrees is not trusted as complete.
    await sink.write(path, wavBytes(0, [1, 0, 2, 0]));
    expect((await inspectKeeperRecovery(sink, path)).kind).toBe("recoverable");
    expect(
      await inspectKeeperRecovery(sink, path, { inspectPending: false }),
    ).toEqual({ kind: "pending" });
  });

  it("does not claim recovery for an OPFS-crash zero-byte file", async () => {
    const sink = new MemorySink();
    await sink.write(path, new Uint8Array());
    await writeRawMeta(sink, path, META);
    const result = await inspectKeeperRecovery(sink, path);
    expect(result).toMatchObject({
      kind: "unrecoverable",
      reason: expect.stringMatching(/committed PCM/i),
    });
  });

  it("reports missing or malformed metadata as unrecoverable", async () => {
    const sink = new MemorySink();
    await sink.write(path, wavBytes(0, [1, 0]));
    expect(await inspectKeeperRecovery(sink, path)).toMatchObject({
      kind: "unrecoverable",
      reason: expect.stringMatching(/no readable recovery metadata/),
    });
    await sink.write(keeperMetaPath(path), new TextEncoder().encode("{"));
    expect((await inspectKeeperRecovery(sink, path)).kind).toBe(
      "unrecoverable",
    );
    await writeRawMeta(sink, path, { ...META, sampleRate: 44_100 });
    expect((await inspectKeeperRecovery(sink, path)).kind).toBe(
      "unrecoverable",
    );
  });

  it("rejects metadata that would place audio in a different segment", async () => {
    const sink = new MemorySink();
    await sink.write(path, wavBytes(0, [1, 0]));
    await writeRawMeta(sink, path, { ...META, sessionId: "wrong-room" });
    expect(await inspectKeeperRecovery(sink, path)).toMatchObject({
      kind: "unrecoverable",
      reason: expect.stringMatching(/invalid placement/),
    });
  });

  it("rejects a WAV that is not in the keeper PCM format", async () => {
    const sink = new MemorySink();
    const stereo = new Uint8Array(48);
    stereo.set(pcmWavHeader(0, 48_000, 2), 0);
    await sink.write(path, stereo);
    await writeRawMeta(sink, path, META);
    expect(await inspectKeeperRecovery(sink, path)).toMatchObject({
      kind: "unrecoverable",
      reason: expect.stringMatching(/not a readable PCM WAV/),
    });
    await sink.write(path, new Uint8Array(48).fill(7));
    expect((await inspectKeeperRecovery(sink, path)).kind).toBe(
      "unrecoverable",
    );
  });

  it("keeps all readable PCM when the stale header underdeclares it", async () => {
    const sink = new MemorySink();
    await sink.write(path, wavBytes(2, [1, 0, 2, 0]));
    await writeRawMeta(sink, path, META);
    await inspectAndRecover(sink, path);
    expect(Array.from((await sink.read(path))!.subarray(44))).toEqual([
      1, 0, 2, 0,
    ]);
  });

  it("repairs a truncated but frame-aligned WAV without inventing samples", async () => {
    const sink = new MemorySink();
    await sink.write(path, wavBytes(8, [1, 0, 2, 0]));
    await writeRawMeta(sink, path, META);
    await inspectAndRecover(sink, path);
    const recovered = (await sink.read(path))!;
    expect(parseWavHeader(recovered.buffer).dataSize).toBe(4);
    expect(Array.from(recovered.subarray(44))).toEqual([1, 0, 2, 0]);
  });

  it("drops only an incomplete trailing frame", async () => {
    const sink = new MemorySink();
    await sink.write(path, wavBytes(0, [1, 0, 2, 0, 9]));
    await writeRawMeta(sink, path, META);
    const plan = await inspectAndRecover(sink, path);
    expect(plan).toMatchObject({ pcmBytes: 4, trimmedBytes: 1 });
    expect(Array.from((await sink.read(path))!.subarray(44))).toEqual([
      1, 0, 2, 0,
    ]);
    // A lone partial frame holds no whole sample to keep.
    await sink.write(path, wavBytes(0, [9]));
    await writeRawMeta(sink, path, META);
    expect((await inspectKeeperRecovery(sink, path)).kind).toBe(
      "unrecoverable",
    );
  });
});

describe("recoverLocalKeepers", () => {
  function segPath(segmentIndex: number): string {
    return keeperWavPath({
      sessionId: "room1",
      participantId: "p_guest",
      takeIndex: 0,
      segmentIndex,
    });
  }

  async function seed(sink: MemorySink, segmentIndex: number, pcm: number[]) {
    await sink.write(segPath(segmentIndex), wavBytes(0, pcm));
    await writeRawMeta(sink, segPath(segmentIndex), {
      ...META,
      takeIndex: 0,
      segmentIndex,
    });
  }

  it("recovers every readable segment and counts trimmed tails", async () => {
    const sink = new MemorySink();
    await seed(sink, 0, [1, 0]);
    await seed(sink, 1, [1, 0, 2]);
    await seed(sink, 2, []);
    expect(await recoverLocalKeepers(sink, "room1", "p_guest", 0)).toEqual({
      recovered: 2,
      trimmed: 1,
    });
  });

  it("keeps going past a failing segment and reports every failure", async () => {
    const sink = new MemorySink();
    await seed(sink, 0, [1, 0]);
    await seed(sink, 1, [2, 0]);
    await seed(sink, 2, [3, 0]);
    const rewrite = sink.rewriteHeader.bind(sink);
    vi.spyOn(sink, "rewriteHeader").mockImplementation(
      async (p, header, length) => {
        if (p === segPath(1)) throw new Error("disk full");
        await rewrite(p, header, length);
      },
    );
    await expect(
      recoverLocalKeepers(sink, "room1", "p_guest", 0),
    ).rejects.toThrow(
      "Recovered 2 partial segments. Take 1, segment 2: disk full",
    );
    expect((await inspectKeeperRecovery(sink, segPath(2))).kind).toBe(
      "complete",
    );
  });

  it("stops before touching a take that resumed mid-run", async () => {
    const sink = new MemorySink();
    await seed(sink, 0, [1, 0]);
    await seed(sink, 1, [2, 0]);
    let allowed = 1;
    await expect(
      recoverLocalKeepers(sink, "room1", "p_guest", 0, () => allowed-- > 0),
    ).rejects.toThrow(/Recording resumed/);
    expect((await inspectKeeperRecovery(sink, segPath(0))).kind).toBe(
      "complete",
    );
    expect((await inspectKeeperRecovery(sink, segPath(1))).kind).toBe(
      "recoverable",
    );
  });
});
