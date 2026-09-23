import { afterEach, describe, expect, it, vi } from "vitest";
import { parseWavHeader, wavPcmToFloat32 } from "../../audio/wavHeader";
import { KEEPER_SAMPLE_RATE, toKeeperPcm } from "./pcm";
import type { KeeperGate } from "./segments";
import {
  KEEPER_STALL_MESSAGE,
  KeeperSession,
  KeeperStallError,
} from "./session";
import {
  type ByteStream,
  keeperMetaPath,
  keeperWavPath,
  MemorySink,
} from "./store";

const ids = { sessionId: "cool-room", participantId: "p_g" };

type Gate = KeeperGate & { sessionId: string; participantId: string };

function recordingGate(overrides: Partial<Gate> = {}): Gate {
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

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Wrap each stream the sink opens; `openIndex` is 1-based. */
function wrapSinkOpen(
  sink: MemorySink,
  wrap: (stream: ByteStream, openIndex: number) => Partial<ByteStream>,
): void {
  const originalOpen = sink.open.bind(sink);
  let opens = 0;
  sink.open = async (path): Promise<ByteStream> => {
    const stream = await originalOpen(path);
    opens += 1;
    return {
      write: (bytes, offset) => stream.write(bytes, offset),
      close: () => stream.close(),
      ...wrap(stream, opens),
    };
  };
}

function segmentPath(segmentIndex: number, takeIndex = 0): string {
  return keeperWavPath({ ...ids, takeIndex, segmentIndex });
}

function pcmBytes(pcm: Float32Array): Uint8Array {
  const int16 = toKeeperPcm(pcm, KEEPER_SAMPLE_RATE);
  return new Uint8Array(int16.buffer);
}

function stallDetail(session: KeeperSession): string | undefined {
  return (session.error?.cause as Error | undefined)?.message;
}

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

afterEach(() => {
  vi.useRealTimers();
});

describe("KeeperSession", () => {
  it("advances after an initial header failure before retrying", async () => {
    const sink = new MemorySink();
    wrapSinkOpen(sink, (stream, opens) => ({
      write: async (bytes, offset) => {
        if (opens === 1) {
          throw new Error("header failed");
        }
        await stream.write(bytes, offset);
      },
    }));
    const session = new KeeperSession(sink);
    await expect(session.apply(recordingGate())).rejects.toThrow(
      "header failed",
    );
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
    const gate = recordingGate();
    await session.apply(gate);
    session.push(tone(440, 0.01), KEEPER_SAMPLE_RATE);
    await expect(session.dispose()).rejects.toThrow("metadata failed");
    const failedWav = sink.files.get(segmentPath(0));
    expect(session.error?.message).toBe("metadata failed");
    await session.apply({ ...gate, roomState: "paused" });
    await session.retry();
    expect(session.error?.message).toBe("metadata failed");
    await session.apply(gate);
    await session.retry();
    session.push(tone(440, 0.01), KEEPER_SAMPLE_RATE);
    await session.dispose();
    // The failed dispose released the open segment but kept its reservation,
    // so the retry does not reopen (and overwrite) segment 0.
    expect(session.files.map((file) => file.segmentIndex)).toEqual([1]);
    expect(sink.files.get(segmentPath(0))).toBe(failedWav);
  });

  it("keeps segment reservations after a clean dispose", async () => {
    const sink = new MemorySink();
    const session = new KeeperSession(sink);
    await session.apply(recordingGate());
    session.push(tone(220, 0.01), KEEPER_SAMPLE_RATE);
    await session.dispose();
    await session.apply(recordingGate({ recordingMs: 20 }));
    session.push(tone(440, 0.01), KEEPER_SAMPLE_RATE);
    await session.dispose();
    expect(session.files.map((file) => file.segmentIndex)).toEqual([0, 1]);
  });

  it("latches a write failure, skips queued PCM, and retries in a new segment", async () => {
    const sink = new MemorySink();
    let writes = 0;
    wrapSinkOpen(sink, (stream) => ({
      write: async (bytes, offset) => {
        writes += 1;
        if (writes === 2) {
          throw new Error("quota exceeded");
        }
        await stream.write(bytes, offset);
      },
    }));
    const failures: Error[] = [];
    const session = new KeeperSession(sink, (error) => failures.push(error));
    await session.apply(recordingGate());
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

  it("coalesces PCM queued behind a slow write into one write", async () => {
    const sink = new MemorySink();
    const slow = deferred();
    const pcmWrites: number[] = [];
    wrapSinkOpen(sink, (stream) => ({
      write: async (bytes, offset) => {
        if (offset !== 0) {
          pcmWrites.push(bytes.byteLength);
          if (pcmWrites.length === 1) {
            await slow.promise;
          }
        }
        await stream.write(bytes, offset);
      },
    }));
    const session = new KeeperSession(sink);
    await session.apply(recordingGate());
    const chunks = Array.from({ length: 50 }, (_, i) =>
      tone(200 + i * 10, 128 / KEEPER_SAMPLE_RATE),
    );
    for (const chunk of chunks) {
      session.push(chunk, KEEPER_SAMPLE_RATE);
    }
    slow.resolve();
    await session.dispose();
    expect(pcmWrites).toEqual([128 * 2, 49 * 128 * 2]);
    expect(session.files[0]?.samplesWritten).toBe(50 * 128);
    const expected = new Uint8Array(50 * 128 * 2);
    chunks.forEach((chunk, i) => {
      expected.set(pcmBytes(chunk), i * 128 * 2);
    });
    expect(sink.files.get(segmentPath(0))?.slice(44)).toEqual(expected);
  });

  it("bounds a stalled PCM backlog and releases retry after a timed-out write", async () => {
    vi.useFakeTimers();
    const sink = new MemorySink();
    const stalled = deferred();
    wrapSinkOpen(sink, (stream, opens) => ({
      write: async (bytes, offset) => {
        if (opens === 1 && offset !== 0) {
          await stalled.promise;
        }
        await stream.write(bytes, offset);
      },
    }));
    const failures: Error[] = [];
    const session = new KeeperSession(sink, (error) => failures.push(error), {
      maxQueuedSamples: 1_000,
      operationTimeoutMs: 10,
    });
    await session.apply(recordingGate());
    session.push(tone(220, 0.01), KEEPER_SAMPLE_RATE);
    expect(session.error).toBeNull();
    session.push(tone(220, 0.01), KEEPER_SAMPLE_RATE);
    await vi.advanceTimersByTimeAsync(10);
    expect(session.error).toBeInstanceOf(KeeperStallError);
    expect(session.error?.message).toBe(KEEPER_STALL_MESSAGE);
    expect(stallDetail(session)).toBe("keeper write timed out after 10ms");
    expect(session.isWriting).toBe(false);
    expect(failures).toHaveLength(1);

    await session.retry();
    expect(session.isWriting).toBe(true);
    session.push(tone(880, 0.01), KEEPER_SAMPLE_RATE);
    session.push(tone(880, 0.01), KEEPER_SAMPLE_RATE);
    session.push(tone(880, 0.01), KEEPER_SAMPLE_RATE);
    expect(session.error?.message).toBe(KEEPER_STALL_MESSAGE);
    expect(stallDetail(session)).toContain("backlog exceeded");
    expect(session.isWriting).toBe(false);
    expect(failures).toHaveLength(2);
    await session.retry();
    expect(session.isWriting).toBe(true);
    const replacement = tone(660, 0.01);
    session.push(replacement, KEEPER_SAMPLE_RATE);
    await session.dispose();
    expect(session.files.map((file) => file.segmentIndex)).toEqual([2]);
    expect(session.files[0]?.samplesWritten).toBe(480);
    const replacementWav = sink.files.get(segmentPath(2));
    expect(replacementWav?.slice(44)).toEqual(pcmBytes(replacement));

    stalled.resolve();
    await vi.advanceTimersByTimeAsync(0);
    // The late write from segment 0 cannot advance or rewrite the replacement.
    expect(session.files.map((file) => file.segmentIndex)).toEqual([2]);
    expect(session.files[0]?.samplesWritten).toBe(480);
    expect(sink.files.get(segmentPath(2))).toBe(replacementWav);
  });

  it("times out a never-settling close without advertising the segment", async () => {
    vi.useFakeTimers();
    const sink = new MemorySink();
    const neverClose = deferred();
    wrapSinkOpen(sink, (stream, opens) => ({
      close: async () => {
        if (opens === 2) {
          await neverClose.promise;
        }
        await stream.close();
      },
    }));
    const session = new KeeperSession(sink, undefined, {
      operationTimeoutMs: 10,
    });
    const gate = recordingGate();
    await session.apply(gate);
    session.push(tone(220, 0.01), KEEPER_SAMPLE_RATE);
    await session.apply({ ...gate, roomState: "paused", recordingMs: 10 });
    expect(session.files.map((file) => file.segmentIndex)).toEqual([0]);
    await session.apply({ ...gate, recordingMs: 20 });
    session.push(tone(440, 0.01), KEEPER_SAMPLE_RATE);
    const stop = session.apply({
      ...gate,
      roomState: "paused",
      recordingMs: 30,
    });
    await vi.advanceTimersByTimeAsync(20);
    await stop;
    expect(stallDetail(session)).toContain("close timed out");
    expect(session.files.map((file) => file.segmentIndex)).toEqual([0]);

    await session.apply({ ...gate, recordingMs: 40 });
    await session.retry();
    const replacement = tone(880, 0.01);
    session.push(replacement, KEEPER_SAMPLE_RATE);
    await session.dispose();
    expect(session.files.map((file) => file.segmentIndex)).toEqual([0, 2]);
    expect(session.files[1]?.samplesWritten).toBe(480);
    const replacementWav = sink.files.get(segmentPath(2));
    expect(replacementWav?.slice(44)).toEqual(pcmBytes(replacement));

    neverClose.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(session.files.map((file) => file.segmentIndex)).toEqual([0, 2]);
    expect(session.files[1]?.samplesWritten).toBe(480);
    expect(sink.files.get(segmentPath(2))).toBe(replacementWav);
  });

  it("scales the close deadline with segment size", async () => {
    vi.useFakeTimers();
    const sink = new MemorySink();
    wrapSinkOpen(sink, (stream) => ({
      close: async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        await stream.close();
      },
    }));
    // 480 samples = 960 bytes at 1 byte/ms: a 970 ms close deadline.
    const session = new KeeperSession(sink, undefined, {
      operationTimeoutMs: 10,
      closeBytesPerMs: 1,
    });
    await session.apply(recordingGate());
    session.push(tone(220, 0.01), KEEPER_SAMPLE_RATE);
    const stop = session.dispose();
    await vi.advanceTimersByTimeAsync(500);
    await stop;
    expect(session.error).toBeNull();
    expect(session.files.map((file) => file.segmentIndex)).toEqual([0]);
  });

  it("keeps metadata that lands after its commit timed out", async () => {
    vi.useFakeTimers();
    const sink = new MemorySink();
    const slowMetadata = deferred();
    const landed = deferred();
    const staleMetaPath = keeperMetaPath(segmentPath(0));
    const originalWrite = sink.write.bind(sink);
    sink.write = async (path, bytes) => {
      if (path === staleMetaPath) {
        await slowMetadata.promise;
        await originalWrite(path, bytes);
        landed.resolve();
        return;
      }
      await originalWrite(path, bytes);
    };
    const remove = vi.spyOn(sink, "remove");
    const session = new KeeperSession(sink, undefined, {
      operationTimeoutMs: 10,
    });
    const gate = recordingGate();
    await session.apply(gate);
    session.push(tone(220, 0.01), KEEPER_SAMPLE_RATE);
    const stop = expect(session.dispose()).rejects.toThrow(
      KEEPER_STALL_MESSAGE,
    );
    await vi.advanceTimersByTimeAsync(10);
    await stop;
    expect(stallDetail(session)).toContain("metadata write timed out");
    expect(session.files).toHaveLength(0);

    await session.apply(gate);
    await session.retry();
    session.push(tone(880, 0.01), KEEPER_SAMPLE_RATE);
    await session.dispose();
    expect(session.files.map((file) => file.segmentIndex)).toEqual([1]);

    slowMetadata.resolve();
    await landed.promise;
    // The WAV closed before the metadata commit, so the late pair is complete.
    expect(sink.files.has(staleMetaPath)).toBe(true);
    expect(remove).not.toHaveBeenCalled();
    expect(session.files.map((file) => file.segmentIndex)).toEqual([1]);
  });

  it("closes a writable whose open lands after the open deadline", async () => {
    vi.useFakeTimers();
    const sink = new MemorySink();
    const lateOpen = deferred<ByteStream>();
    const lateClose = vi.fn(async () => undefined);
    const originalOpen = sink.open.bind(sink);
    let opens = 0;
    sink.open = async (path) => {
      opens += 1;
      return opens === 1 ? lateOpen.promise : originalOpen(path);
    };
    const session = new KeeperSession(sink, undefined, {
      operationTimeoutMs: 10,
    });
    const apply = expect(session.apply(recordingGate())).rejects.toThrow(
      KEEPER_STALL_MESSAGE,
    );
    await vi.advanceTimersByTimeAsync(10);
    await apply;
    expect(stallDetail(session)).toBe("keeper open timed out after 10ms");

    lateOpen.resolve({ write: async () => undefined, close: lateClose });
    await vi.advanceTimersByTimeAsync(0);
    expect(lateClose).toHaveBeenCalledTimes(1);

    await session.retry();
    session.push(tone(440, 0.01), KEEPER_SAMPLE_RATE);
    await session.dispose();
    expect(session.files.map((file) => file.segmentIndex)).toEqual([1]);
  });

  it("closes the writable after an initial header write times out", async () => {
    vi.useFakeTimers();
    const sink = new MemorySink();
    const closes: number[] = [];
    wrapSinkOpen(sink, (stream, opens) => ({
      write: async (bytes, offset) => {
        if (opens === 1) {
          await new Promise(() => undefined);
        }
        await stream.write(bytes, offset);
      },
      close: async () => {
        closes.push(opens);
        await stream.close();
      },
    }));
    const session = new KeeperSession(sink, undefined, {
      operationTimeoutMs: 10,
    });
    const apply = expect(session.apply(recordingGate())).rejects.toThrow(
      KEEPER_STALL_MESSAGE,
    );
    await vi.advanceTimersByTimeAsync(10);
    await apply;
    expect(stallDetail(session)).toBe(
      "keeper header write timed out after 10ms",
    );
    expect(closes).toEqual([1]);

    await session.retry();
    session.push(tone(440, 0.01), KEEPER_SAMPLE_RATE);
    await session.dispose();
    expect(session.files.map((file) => file.segmentIndex)).toEqual([1]);
  });

  it("does not advertise a segment whose final header write times out", async () => {
    vi.useFakeTimers();
    const sink = new MemorySink();
    const closes = vi.fn();
    wrapSinkOpen(sink, (stream) => {
      let headers = 0;
      return {
        write: async (bytes, offset) => {
          if (offset === 0 && ++headers === 2) {
            await new Promise(() => undefined);
          }
          await stream.write(bytes, offset);
        },
        close: async () => {
          closes();
          await stream.close();
        },
      };
    });
    const session = new KeeperSession(sink, undefined, {
      operationTimeoutMs: 10,
    });
    await session.apply(recordingGate());
    session.push(tone(220, 0.01), KEEPER_SAMPLE_RATE);
    const stop = session.dispose();
    await vi.advanceTimersByTimeAsync(10);
    await stop;
    expect(stallDetail(session)).toBe(
      "keeper final header write timed out after 10ms",
    );
    expect(session.files).toHaveLength(0);
    expect(closes).toHaveBeenCalledTimes(1);
    expect(sink.files.has(keeperMetaPath(segmentPath(0)))).toBe(false);
  });

  it.each([
    ["closes", false],
    ["hangs", true],
  ])(
    "holds dispose while a failed writable %s, up to its deadline",
    async (_label, hangs) => {
      vi.useFakeTimers();
      const sink = new MemorySink();
      const slowClose = deferred();
      let writes = 0;
      wrapSinkOpen(sink, (stream) => ({
        write: async (bytes, offset) => {
          writes += 1;
          if (writes === 2) {
            throw new Error("quota exceeded");
          }
          await stream.write(bytes, offset);
        },
        close: async () => {
          await slowClose.promise;
          await stream.close();
        },
      }));
      const session = new KeeperSession(sink, undefined, {
        operationTimeoutMs: 10,
      });
      await session.apply(recordingGate());
      session.push(tone(220, 0.01), KEEPER_SAMPLE_RATE);
      await session.flush();
      let disposed = false;
      const stop = session.dispose().then(() => {
        disposed = true;
      });
      await vi.advanceTimersByTimeAsync(5);
      expect(disposed).toBe(false);
      if (hangs) {
        await vi.advanceTimersByTimeAsync(5);
      } else {
        slowClose.resolve();
      }
      await stop;
      expect(disposed).toBe(true);
      expect(session.error?.message).toBe("quota exceeded");
    },
  );

  it("times out a stalled segment scan when restoring the cursor", async () => {
    vi.useFakeTimers();
    const sink = new MemorySink();
    sink.nextSegmentIndex = () => new Promise(() => undefined);
    const session = new KeeperSession(sink, undefined, {
      operationTimeoutMs: 10,
    });
    const restore = expect(
      session.restoreCursor(ids.sessionId, 0, ids.participantId),
    ).rejects.toThrow(KEEPER_STALL_MESSAGE);
    await vi.advanceTimersByTimeAsync(10);
    await restore;
  });

  it("keeps later failed PCM out of metadata and resumes at the current offset", async () => {
    const sink = new MemorySink();
    let writes = 0;
    wrapSinkOpen(sink, (stream) => ({
      write: async (bytes, offset) => {
        writes += 1;
        if (writes === 3) {
          throw new Error("late quota failure");
        }
        await stream.write(bytes, offset);
      },
    }));
    const session = new KeeperSession(sink);
    const gate = recordingGate();
    await session.apply(gate);
    session.push(tone(220, 0.02), KEEPER_SAMPLE_RATE);
    await session.flush();
    session.push(tone(440, 0.02), KEEPER_SAMPLE_RATE);
    session.push(tone(880, 0.02), KEEPER_SAMPLE_RATE);
    await session.flush();
    expect(session.error?.message).toBe("late quota failure");
    expect(session.isWriting).toBe(false);
    expect(session.files).toHaveLength(0);
    expect(sink.files.get(segmentPath(0))?.byteLength).toBeGreaterThan(44);

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
    let opens = 0;
    let failClose = true;
    wrapSinkOpen(sink, (stream, openIndex) => {
      opens = openIndex;
      return {
        close: async () => {
          if (failClose) {
            failClose = false;
            throw new Error("close failed");
          }
          await stream.close();
        },
      };
    });
    const session = new KeeperSession(sink);
    const gate = recordingGate();
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
    const pending = deferred();
    const queuedWrite = deferred();
    wrapSinkOpen(sink, (stream) => {
      let writes = 0;
      return {
        write: async (bytes, offset) => {
          writes += 1;
          if (writes > 2) {
            queuedWrite.resolve();
            await pending.promise;
          }
          await stream.write(bytes, offset);
        },
      };
    });
    const session = new KeeperSession(sink);
    await session.apply(recordingGate());
    session.push(tone(220, 0.02), KEEPER_SAMPLE_RATE);
    session.push(tone(220, 0.02), KEEPER_SAMPLE_RATE);
    const flush = session.flush();
    await queuedWrite.promise;
    try {
      expect(sink.files.get(segmentPath(0))?.byteLength).toBeGreaterThan(44);
    } finally {
      pending.resolve();
    }
    await flush;
    await session.dispose();
    expect(session.files[0]?.samplesWritten).toBe(1_920);
  });

  it("writes no bytes until recording after consent", async () => {
    const sink = new MemorySink();
    const session = new KeeperSession(sink);
    await session.apply(recordingGate({ roomState: "lobby", takeIndex: -1 }));
    session.push(tone(220, 0.05), KEEPER_SAMPLE_RATE);
    await session.dispose();
    expect(sink.files.size).toBe(0);
  });

  it("encodes a 48 kHz 16-bit mono WAV for a recording segment", async () => {
    const sink = new MemorySink();
    const session = new KeeperSession(sink);
    await session.apply(recordingGate());
    session.push(tone(220, 0.1), KEEPER_SAMPLE_RATE);
    await session.flush();
    const growing = sink.files.get(segmentPath(0));
    expect(growing?.byteLength).toBeGreaterThan(44);
    await session.dispose();
    const wav = sink.files.get(segmentPath(0));
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
    const live = recordingGate();
    await session.apply(live);
    session.push(tone(440, 0.05), KEEPER_SAMPLE_RATE);
    await session.apply({ ...live, muted: true });
    session.push(tone(440, 0.05), KEEPER_SAMPLE_RATE);
    await session.dispose();
    const wav = sink.files.get(segmentPath(0));
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
    await session.apply(recordingGate());
    session.push(tone(220, 0.02), KEEPER_SAMPLE_RATE);
    await session.apply(
      recordingGate({ roomState: "paused", recordingMs: 20 }),
    );
    const afterPause = sink.files.size;
    session.push(tone(220, 0.1), KEEPER_SAMPLE_RATE);
    expect(sink.files.size).toBe(afterPause);
    await session.apply(recordingGate({ recordingMs: 20 }));
    session.push(tone(880, 0.02), KEEPER_SAMPLE_RATE);
    await session.dispose();
    expect(session.files.map((f) => f.segmentIndex)).toEqual([0, 1]);
    expect(session.files[1]?.joinOffsetMs).toBe(20);
  });

  it("finalizes on mic loss and resumes at the next segment", async () => {
    const sink = new MemorySink();
    const session = new KeeperSession(sink);
    await session.apply(recordingGate());
    session.push(tone(220, 0.02), KEEPER_SAMPLE_RATE);
    await session.apply(
      recordingGate({ streamAvailable: false, recordingMs: 20 }),
    );
    expect(session.isWriting).toBe(false);
    await session.apply(recordingGate({ recordingMs: 40 }));
    session.push(tone(880, 0.02), KEEPER_SAMPLE_RATE);
    await session.dispose();
    expect(session.files.map((file) => file.segmentIndex)).toEqual([0, 1]);
    expect(session.files[1]?.joinOffsetMs).toBe(40);
  });

  it("never writes for a producer", async () => {
    const sink = new MemorySink();
    const session = new KeeperSession(sink);
    await session.apply(
      recordingGate({
        participantId: "p_prod",
        role: "producer",
        consented: null,
      }),
    );
    session.push(tone(220, 0.05), KEEPER_SAMPLE_RATE);
    await session.dispose();
    expect(sink.files.size).toBe(0);
  });

  it("serializes overlapping apply calls", async () => {
    const sink = new MemorySink();
    const session = new KeeperSession(sink);
    const live = recordingGate();
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
    await first.apply(recordingGate());
    first.push(tone(220, 0.02), KEEPER_SAMPLE_RATE);
    await first.dispose();
    const second = new KeeperSession(sink);
    await second.restoreCursor(ids.sessionId, 0, ids.participantId);
    await second.apply(recordingGate({ recordingMs: 20 }));
    second.push(tone(880, 0.02), KEEPER_SAMPLE_RATE);
    await second.dispose();
    expect(second.files.map((f) => f.segmentIndex)).toEqual([1]);
  });

  it("does not collide with an orphaned WAV that has no metadata after reload", async () => {
    const sink = new MemorySink();
    const orphan = new Uint8Array(64).fill(7);
    await sink.write(segmentPath(0), orphan);
    const session = new KeeperSession(sink);
    await session.restoreCursor(ids.sessionId, 0, ids.participantId);
    await session.apply(recordingGate({ recordingMs: 20 }));
    session.push(tone(880, 0.02), KEEPER_SAMPLE_RATE);
    await session.dispose();
    expect(session.files.map((f) => f.segmentIndex)).toEqual([1]);
    expect(sink.files.get(segmentPath(0))).toBe(orphan);
    expect(sink.files.has(keeperMetaPath(segmentPath(0)))).toBe(false);
  });
});
