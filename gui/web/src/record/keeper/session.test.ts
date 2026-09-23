import { describe, expect, it } from "vitest";
import { parseWavHeader, wavPcmToFloat32 } from "../../audio/wavHeader";
import { KEEPER_SAMPLE_RATE } from "./pcm";
import { KeeperSession } from "./session";
import { type ByteStream, keeperWavPath, MemorySink } from "./store";

const ids = { sessionId: "cool-room", participantId: "p_g" };

function tone(
  hz: number,
  seconds: number,
  rate = KEEPER_SAMPLE_RATE,
): Float32Array {
  const n = Math.floor(seconds * rate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = Math.sin((2 * Math.PI * hz * i) / rate);
  }
  return out;
}

describe("KeeperSession", () => {
  it("advances after an initial header failure before retrying", async () => {
    const sink = new MemorySink();
    let opens = 0;
    const originalOpen = sink.open.bind(sink);
    sink.open = async (path): Promise<ByteStream> => {
      const stream = await originalOpen(path);
      opens += 1;
      return {
        write: async (bytes, offset) => {
          if (opens === 1) {
            throw new Error("header failed");
          }
          await stream.write(bytes, offset);
        },
        close: () => stream.close(),
      };
    };
    const session = new KeeperSession(sink);
    const gate = {
      ...ids,
      role: "guest" as const,
      consented: true as const,
      roomState: "recording" as const,
      takeIndex: 0,
      recordingMs: 0,
      streamAvailable: true,
      muted: false,
    };
    await expect(session.apply(gate)).rejects.toThrow("header failed");
    await session.retry();
    session.push(tone(440, 0.01), KEEPER_SAMPLE_RATE);
    await session.dispose();
    expect(session.files.map((file) => file.segmentIndex)).toEqual([1]);
  });

  it("latches metadata failures and recovers only on an active retry", async () => {
    const sink = new MemorySink();
    let failMetadata = true;
    const originalWrite = sink.write.bind(sink);
    sink.write = async (path, bytes) => {
      if (path.endsWith(".json") && failMetadata) {
        failMetadata = false;
        throw new Error("metadata failed");
      }
      await originalWrite(path, bytes);
    };
    const session = new KeeperSession(sink);
    const gate = {
      ...ids,
      role: "guest" as const,
      consented: true as const,
      roomState: "recording" as const,
      takeIndex: 0,
      recordingMs: 0,
      streamAvailable: true,
      muted: false,
    };
    await session.apply(gate);
    session.push(tone(440, 0.01), KEEPER_SAMPLE_RATE);
    await expect(session.dispose()).rejects.toThrow("metadata failed");
    expect(session.error?.message).toBe("metadata failed");
    await session.apply({ ...gate, roomState: "paused" });
    await session.retry();
    expect(session.error?.message).toBe("metadata failed");
    await session.apply(gate);
    await session.retry();
    session.push(tone(440, 0.01), KEEPER_SAMPLE_RATE);
    await session.dispose();
    expect(session.files.map((file) => file.segmentIndex)).toEqual([1]);
  });

  it("latches a write failure, skips queued PCM, and retries in a new segment", async () => {
    const sink = new MemorySink();
    let writes = 0;
    const originalOpen = sink.open.bind(sink);
    sink.open = async (path): Promise<ByteStream> => {
      const stream = await originalOpen(path);
      return {
        write: async (bytes, offset) => {
          writes += 1;
          if (writes === 2) {
            throw new Error("quota exceeded");
          }
          await stream.write(bytes, offset);
        },
        close: () => stream.close(),
      };
    };
    const failures: Error[] = [];
    const session = new KeeperSession(sink, (error) => failures.push(error));
    const gate = {
      ...ids,
      role: "guest" as const,
      consented: true as const,
      roomState: "recording" as const,
      takeIndex: 0,
      recordingMs: 0,
      streamAvailable: true,
      muted: false,
    };
    await session.apply(gate);
    session.push(tone(220, 0.02), KEEPER_SAMPLE_RATE);
    session.push(tone(220, 0.02), KEEPER_SAMPLE_RATE);
    await session.flush();
    expect(session.isWriting).toBe(false);
    expect(failures).toHaveLength(1);
    expect(session.files).toHaveLength(0);

    await session.retry();
    expect(session.isWriting).toBe(true);
    session.push(tone(880, 0.02), KEEPER_SAMPLE_RATE);
    await session.dispose();
    expect(session.files.map((file) => file.segmentIndex)).toEqual([1]);
    expect(failures).toHaveLength(1);
  });

  it("keeps a later failed PCM write out of metadata and resumes at the current offset", async () => {
    const sink = new MemorySink();
    const originalOpen = sink.open.bind(sink);
    let writes = 0;
    sink.open = async (path): Promise<ByteStream> => {
      const stream = await originalOpen(path);
      return {
        write: async (bytes, offset) => {
          writes += 1;
          if (writes === 3) {
            throw new Error("late quota failure");
          }
          await stream.write(bytes, offset);
        },
        close: () => stream.close(),
      };
    };
    const session = new KeeperSession(sink);
    const gate = {
      ...ids,
      role: "guest" as const,
      consented: true as const,
      roomState: "recording" as const,
      takeIndex: 0,
      recordingMs: 0,
      streamAvailable: true,
      muted: false,
    };
    await session.apply(gate);
    session.push(tone(220, 0.02), KEEPER_SAMPLE_RATE);
    await session.flush();
    session.push(tone(440, 0.02), KEEPER_SAMPLE_RATE);
    session.push(tone(880, 0.02), KEEPER_SAMPLE_RATE);
    await session.flush();
    expect(session.error?.message).toBe("late quota failure");
    expect(session.isWriting).toBe(false);
    expect(session.files).toHaveLength(0);
    const partialPath = keeperWavPath({
      ...ids,
      takeIndex: 0,
      segmentIndex: 0,
    });
    expect(sink.files.get(partialPath)?.byteLength).toBeGreaterThan(44);

    await session.apply({ ...gate, recordingMs: 12_000 });
    await session.retry();
    session.push(tone(440, 0.02), KEEPER_SAMPLE_RATE);
    await session.dispose();
    expect(
      session.files.map((file) => [file.segmentIndex, file.joinOffsetMs]),
    ).toEqual([[1, 12_000]]);
  });

  it("does not open the next take after a failed segment close", async () => {
    const sink = new MemorySink();
    const originalOpen = sink.open.bind(sink);
    let opens = 0;
    let failClose = true;
    sink.open = async (path): Promise<ByteStream> => {
      opens += 1;
      const stream = await originalOpen(path);
      return {
        write: (bytes, offset) => stream.write(bytes, offset),
        close: async () => {
          if (failClose) {
            failClose = false;
            throw new Error("close failed");
          }
          await stream.close();
        },
      };
    };
    const session = new KeeperSession(sink);
    const gate = {
      ...ids,
      role: "guest" as const,
      consented: true as const,
      roomState: "recording" as const,
      takeIndex: 0,
      recordingMs: 0,
      streamAvailable: true,
      muted: false,
    };
    await session.apply(gate);
    session.push(tone(220, 0.02), KEEPER_SAMPLE_RATE);
    await session.apply({ ...gate, takeIndex: 1, recordingMs: 4_000 });
    expect(session.error?.message).toBe("close failed");
    expect(session.isWriting).toBe(false);
    expect(opens).toBe(1);

    await session.retry();
    expect(session.isWriting).toBe(true);
    expect(opens).toBe(2);
    session.push(tone(440, 0.02), KEEPER_SAMPLE_RATE);
    await session.dispose();
    expect(
      session.files.map((file) => [file.takeIndex, file.segmentIndex]),
    ).toEqual([[1, 0]]);
  });

  it("does not count PCM until its write resolves", async () => {
    const sink = new MemorySink();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let queuedWriteStarted!: () => void;
    const queuedWrite = new Promise<void>((resolve) => {
      queuedWriteStarted = resolve;
    });
    const originalOpen = sink.open.bind(sink);
    sink.open = async (path): Promise<ByteStream> => {
      const stream = await originalOpen(path);
      let writes = 0;
      return {
        write: async (bytes, offset) => {
          writes += 1;
          if (writes > 2) {
            queuedWriteStarted();
            await pending;
          }
          await stream.write(bytes, offset);
        },
        close: () => stream.close(),
      };
    };
    const session = new KeeperSession(sink);
    await session.apply({
      ...ids,
      role: "guest",
      consented: true,
      roomState: "recording",
      takeIndex: 0,
      recordingMs: 0,
      streamAvailable: true,
      muted: false,
    });
    session.push(tone(220, 0.02), KEEPER_SAMPLE_RATE);
    session.push(tone(220, 0.02), KEEPER_SAMPLE_RATE);
    const flush = session.flush();
    await queuedWrite;
    try {
      expect(
        sink.files.get(keeperWavPath({ ...ids, takeIndex: 0, segmentIndex: 0 }))
          ?.byteLength,
      ).toBeGreaterThan(44);
    } finally {
      release();
    }
    await flush;
    await session.dispose();
    expect(session.files[0]?.samplesWritten).toBe(1_920);
  });

  it("writes no bytes until recording after consent", async () => {
    const sink = new MemorySink();
    const session = new KeeperSession(sink);
    await session.apply({
      ...ids,
      role: "guest",
      consented: true,
      roomState: "lobby",
      takeIndex: -1,
      recordingMs: 0,
      streamAvailable: true,
      muted: false,
    });
    session.push(tone(220, 0.05), KEEPER_SAMPLE_RATE);
    await session.dispose();
    expect(sink.files.size).toBe(0);
  });

  it("encodes a 48 kHz 16-bit mono WAV for a recording segment", async () => {
    const sink = new MemorySink();
    const session = new KeeperSession(sink);
    await session.apply({
      ...ids,
      role: "guest",
      consented: true,
      roomState: "recording",
      takeIndex: 0,
      recordingMs: 0,
      streamAvailable: true,
      muted: false,
    });
    session.push(tone(220, 0.1), KEEPER_SAMPLE_RATE);
    await session.flush();
    const wavPath = keeperWavPath({
      sessionId: ids.sessionId,
      takeIndex: 0,
      participantId: ids.participantId,
      segmentIndex: 0,
    });
    const growing = sink.files.get(wavPath);
    expect(growing?.byteLength).toBeGreaterThan(44);
    await session.dispose();
    const wav = sink.files.get(wavPath);
    expect(wav).toBeTruthy();
    const header = parseWavHeader(wav!.buffer);
    expect(header.sampleRate).toBe(48000);
    expect(header.channels).toBe(1);
    expect(header.bitsPerSample).toBe(16);
    expect(session.files[0]?.samplesWritten).toBeGreaterThan(4000);
  });

  it("writes zeros for a muted span without shortening the file", async () => {
    const sink = new MemorySink();
    const session = new KeeperSession(sink);
    const live = {
      ...ids,
      role: "guest" as const,
      consented: true as const,
      roomState: "recording" as const,
      takeIndex: 0,
      recordingMs: 0,
      streamAvailable: true,
      muted: false,
    };
    await session.apply(live);
    session.push(tone(440, 0.05), KEEPER_SAMPLE_RATE);
    await session.apply({ ...live, muted: true });
    session.push(tone(440, 0.05), KEEPER_SAMPLE_RATE);
    await session.dispose();
    const wavPath = keeperWavPath({
      sessionId: ids.sessionId,
      takeIndex: 0,
      participantId: ids.participantId,
      segmentIndex: 0,
    });
    const wav = sink.files.get(wavPath);
    expect(wav).toBeTruthy();
    const header = parseWavHeader(wav!.buffer);
    const peak = wavPcmToFloat32(wav!.buffer.slice(header.dataOffset), header);
    const half = Math.floor(peak.length / 2);
    const livePeak = Math.max(...peak.subarray(0, half));
    const mutePeak = Math.max(...peak.subarray(half));
    expect(livePeak).toBeGreaterThan(0.5);
    expect(mutePeak).toBe(0);
  });

  it("writes nothing during pause and opens a second segment on resume", async () => {
    const sink = new MemorySink();
    const session = new KeeperSession(sink);
    const base = {
      ...ids,
      role: "guest" as const,
      consented: true as const,
      takeIndex: 0,
      muted: false,
      streamAvailable: true,
    };
    await session.apply({ ...base, roomState: "recording", recordingMs: 0 });
    session.push(tone(220, 0.02), KEEPER_SAMPLE_RATE);
    await session.apply({ ...base, roomState: "paused", recordingMs: 20 });
    const afterPause = sink.files.size;
    session.push(tone(220, 0.1), KEEPER_SAMPLE_RATE);
    expect(sink.files.size).toBe(afterPause);
    await session.apply({
      ...base,
      roomState: "recording",
      recordingMs: 20,
    });
    session.push(tone(880, 0.02), KEEPER_SAMPLE_RATE);
    await session.dispose();
    expect(session.files.map((f) => f.segmentIndex)).toEqual([0, 1]);
    expect(session.files[1]?.joinOffsetMs).toBe(20);
  });

  it("finalizes on mic loss and resumes at the next segment", async () => {
    const sink = new MemorySink();
    const session = new KeeperSession(sink);
    const base = {
      ...ids,
      role: "guest" as const,
      consented: true as const,
      roomState: "recording" as const,
      takeIndex: 0,
      recordingMs: 0,
      streamAvailable: true,
      muted: false,
    };
    await session.apply({ ...base, streamAvailable: true });
    session.push(tone(220, 0.02), KEEPER_SAMPLE_RATE);
    await session.apply({
      ...base,
      streamAvailable: false,
      recordingMs: 20,
    });
    expect(session.isWriting).toBe(false);
    await session.apply({
      ...base,
      streamAvailable: true,
      recordingMs: 40,
    });
    session.push(tone(880, 0.02), KEEPER_SAMPLE_RATE);
    await session.dispose();
    expect(session.files.map((file) => file.segmentIndex)).toEqual([0, 1]);
    expect(session.files[1]?.joinOffsetMs).toBe(40);
  });

  it("never writes for a producer", async () => {
    const sink = new MemorySink();
    const session = new KeeperSession(sink);
    await session.apply({
      sessionId: "cool-room",
      participantId: "p_prod",
      role: "producer",
      consented: null,
      roomState: "recording",
      takeIndex: 0,
      recordingMs: 0,
      streamAvailable: true,
      muted: false,
    });
    session.push(tone(220, 0.05), KEEPER_SAMPLE_RATE);
    await session.dispose();
    expect(sink.files.size).toBe(0);
  });

  it("serializes overlapping apply calls", async () => {
    const sink = new MemorySink();
    const session = new KeeperSession(sink);
    const live = {
      ...ids,
      role: "guest" as const,
      consented: true as const,
      roomState: "recording" as const,
      takeIndex: 0,
      recordingMs: 0,
      streamAvailable: true,
      muted: false,
    };
    const first = session.apply(live);
    const second = session.apply({ ...live, muted: true });
    await Promise.all([first, second]);
    session.push(tone(440, 0.02), KEEPER_SAMPLE_RATE);
    await session.dispose();
    expect(session.files).toHaveLength(1);
  });

  it("resumes segment indexes from existing sink files", async () => {
    const sink = new MemorySink();
    const first = new KeeperSession(sink);
    await first.apply({
      ...ids,
      role: "guest",
      consented: true,
      roomState: "recording",
      takeIndex: 0,
      recordingMs: 0,
      streamAvailable: true,
      muted: false,
    });
    first.push(tone(220, 0.02), KEEPER_SAMPLE_RATE);
    await first.dispose();
    const second = new KeeperSession(sink);
    await second.restoreCursor(ids.sessionId, 0, ids.participantId);
    await second.apply({
      ...ids,
      role: "guest",
      consented: true,
      roomState: "recording",
      takeIndex: 0,
      recordingMs: 20,
      muted: false,
      streamAvailable: true,
    });
    second.push(tone(880, 0.02), KEEPER_SAMPLE_RATE);
    await second.dispose();
    expect(second.files.map((f) => f.segmentIndex)).toEqual([1]);
  });
});
