import { pcmWavHeader } from "../../audio/wavHeader";
import { sha256Hex } from "./fingerprint";
import { KEEPER_SAMPLE_RATE, toKeeperPcm } from "./pcm";
import {
  emptyKeeperCursor,
  type KeeperGate,
  type OpenSegment,
  planKeeperSegment,
} from "./segments";
import {
  type ByteSink,
  type ByteStream,
  type KeeperMeta,
  keeperWavPath,
  writeKeeperMeta,
} from "./store";

/**
 * Ceiling for PCM waiting on OPFS. It sits well above the per-operation limit,
 * so a burst delivered after a main-thread stall (background tab, GC, long
 * task) does not fail capture while OPFS itself is healthy; a write that truly
 * hangs trips the operation limit first.
 */
export const KEEPER_MAX_QUEUED_SAMPLES = KEEPER_SAMPLE_RATE * 15;
export const KEEPER_OPERATION_TIMEOUT_MS = 5_000;
/**
 * Conservative OPFS commit throughput. `createWritable()` stages writes in a
 * swap file that close() commits, so the close deadline grows with segment
 * size instead of failing a long, healthy segment.
 */
export const KEEPER_CLOSE_BYTES_PER_MS = 10_000;
/** Guest-facing reason; the technical detail is kept on `Error.cause`. */
export const KEEPER_STALL_MESSAGE = "this device's storage couldn't keep up.";

const WAV_HEADER_BYTES = 44;
const BYTES_PER_SAMPLE = 2;

export type KeeperSessionOptions = {
  maxQueuedSamples?: number;
  operationTimeoutMs?: number;
  closeBytesPerMs?: number;
};

/** OPFS was too slow or stalled; `cause` carries the technical detail. */
export class KeeperStallError extends Error {
  constructor(detail: string) {
    super(KEEPER_STALL_MESSAGE, { cause: new Error(detail) });
    this.name = "KeeperStallError";
  }
}

function pcmBytes(chunks: Int16Array[], samples: number): Uint8Array {
  const [only] = chunks;
  if (chunks.length === 1 && only) {
    return new Uint8Array(only.buffer, only.byteOffset, only.byteLength);
  }
  const joined = new Int16Array(samples);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.length;
  }
  return new Uint8Array(joined.buffer);
}

export class KeeperSession {
  private cursor = emptyKeeperCursor();
  /** PCM samples committed to the open segment. */
  private samples = 0;
  private writing = false;
  private muted = false;
  private current: OpenSegment | null = null;
  private stream: ByteStream | null = null;
  private wavPath: string | null = null;
  private sessionId = "";
  private participantId = "";
  private pending: Int16Array[] = [];
  private pendingSamples = 0;
  private inFlightSamples = 0;
  private draining = false;
  private drain: Promise<void> = Promise.resolve();
  /**
   * The only staleness token for asynchronous OPFS work. It advances whenever
   * the open segment is released (clearOpenSegment) or capture fails (fail),
   * so a write started under an older epoch can never advance the current
   * segment, even if its timed-out promise settles much later.
   */
  private epoch = 0;
  private failure: Error | null = null;
  /** In-flight `complete:false` metadata write for the open segment. */
  private pendingMeta: Promise<void> | null = null;
  private lastGate:
    | (KeeperGate & {
        sessionId: string;
        participantId: string;
      })
    | null = null;
  private readonly onFailure?: (error: Error) => void;
  private mutex: Promise<void> = Promise.resolve();
  readonly files: KeeperMeta[] = [];
  private readonly sink: ByteSink;
  private readonly maxQueuedSamples: number;
  private readonly operationTimeoutMs: number;
  private readonly closeBytesPerMs: number;

  constructor(
    sink: ByteSink,
    onFailure?: (error: Error) => void,
    options: KeeperSessionOptions = {},
  ) {
    this.sink = sink;
    this.onFailure = onFailure;
    this.maxQueuedSamples =
      options.maxQueuedSamples ?? KEEPER_MAX_QUEUED_SAMPLES;
    this.operationTimeoutMs =
      options.operationTimeoutMs ?? KEEPER_OPERATION_TIMEOUT_MS;
    this.closeBytesPerMs = options.closeBytesPerMs ?? KEEPER_CLOSE_BYTES_PER_MS;
  }

  get isWriting(): boolean {
    return this.writing;
  }

  get error(): Error | null {
    return this.failure;
  }

  async restoreCursor(
    sessionId: string,
    takeIndex: number,
    participantId: string,
  ): Promise<void> {
    await this.lock(async () => {
      const next = await this.bounded(
        this.sink.nextSegmentIndex(sessionId, takeIndex, participantId),
        "segment scan",
      );
      this.sessionId = sessionId;
      this.participantId = participantId;
      this.cursor = {
        takeIndex,
        nextSegmentIndex: next,
        open: null,
      };
    });
  }

  async apply(
    gate: KeeperGate & { sessionId: string; participantId: string },
  ): Promise<void> {
    this.lastGate = gate;
    await this.lock(() => this.applyLocked(gate));
  }

  push(pcm: Float32Array, sourceRate: number): void {
    if (!this.writing || !this.current || !this.stream) {
      return;
    }
    const int16 = toKeeperPcm(pcm, sourceRate, this.muted);
    const queued = this.pendingSamples + this.inFlightSamples;
    if (queued + int16.length > this.maxQueuedSamples) {
      this.fail(
        new KeeperStallError(
          `keeper PCM backlog exceeded ${this.maxQueuedSamples} samples`,
        ),
      );
      return;
    }
    this.pending.push(int16);
    this.pendingSamples += int16.length;
    if (!this.draining) {
      this.draining = true;
      this.drain = this.drainPending(this.stream, this.epoch);
    }
  }

  async flush(): Promise<void> {
    await this.drain;
  }

  async dispose(): Promise<void> {
    await this.lock(async () => {
      this.writing = false;
      try {
        await this.finalizeOpen();
      } finally {
        // Release the open segment even when finalize fails, but keep the
        // reserved index so a reused session never reopens a written path.
        this.cursor = { ...this.cursor, open: null };
      }
    });
  }

  async retry(): Promise<void> {
    await this.lock(async () => {
      if (!this.failure || this.lastGate?.roomState !== "recording") {
        return;
      }
      await this.finalizeOpen();
      this.failure = null;
      if (this.lastGate) {
        await this.applyLocked(this.lastGate);
      }
    });
  }

  private async lock(fn: () => Promise<void>): Promise<void> {
    const run = this.mutex.then(fn, fn);
    this.mutex = run.then(
      () => undefined,
      () => undefined,
    );
    await run;
  }

  /**
   * Single writer for the open segment. Chunks that queue while a write is in
   * flight are coalesced into the next write, so a stall costs one bounded
   * write (and one timer) rather than one per 128-frame chunk.
   */
  private async drainPending(stream: ByteStream, epoch: number): Promise<void> {
    try {
      while (epoch === this.epoch && this.pending.length > 0) {
        const chunks = this.pending;
        const count = this.pendingSamples;
        this.pending = [];
        this.pendingSamples = 0;
        this.inFlightSamples = count;
        const offset = WAV_HEADER_BYTES + this.samples * BYTES_PER_SAMPLE;
        await this.bounded(
          stream.write(pcmBytes(chunks, count), offset),
          "write",
        );
        if (epoch !== this.epoch) {
          return;
        }
        this.samples += count;
        this.inFlightSamples = 0;
      }
    } catch (error) {
      if (epoch === this.epoch) {
        this.fail(error);
      }
    } finally {
      if (epoch === this.epoch) {
        this.draining = false;
      }
    }
  }

  private async applyLocked(
    gate: KeeperGate & { sessionId: string; participantId: string },
  ): Promise<void> {
    this.sessionId = gate.sessionId;
    this.participantId = gate.participantId;
    if (this.failure) {
      this.writing = false;
      return;
    }
    const plan = planKeeperSegment(gate, this.cursor);
    this.writing = false;
    if (plan.close) {
      await this.finalizeOpen();
      if (this.failure) {
        return;
      }
    }
    // Reserve the segment before opening the writable. If opening or writing
    // the header fails, retry must advance past this segment rather than
    // reusing its path. finalizeOpen's late-metadata handling relies on this.
    this.cursor = plan.cursor;
    this.muted = plan.muted;
    if (plan.open) {
      this.current = plan.open;
      this.samples = 0;
      const wavPath = keeperWavPath({
        sessionId: this.sessionId,
        takeIndex: plan.open.takeIndex,
        participantId: this.participantId,
        segmentIndex: plan.open.segmentIndex,
      });
      this.wavPath = wavPath;
      let opened: Promise<ByteStream> | null = null;
      try {
        opened = this.sink.open(wavPath);
        this.stream = await this.bounded(opened, "open");
        await this.bounded(
          this.stream.write(pcmWavHeader(0, KEEPER_SAMPLE_RATE, 1), 0),
          "header write",
        );
      } catch (error) {
        this.fail(error);
        if (this.stream) {
          await this.closeBounded(this.stream, 0);
        } else if (opened) {
          // An open that lands after its deadline still holds a writable.
          void opened.then(
            (late) => this.closeBounded(late, 0),
            () => undefined,
          );
        }
        this.clearOpenSegment();
        throw error;
      }
      // Record the pending segment without holding capture closed: samples
      // pushed while this OPFS round trip runs are kept. finalizeOpen awaits
      // it so it can never land after (and overwrite) the complete record.
      const open = plan.open;
      this.pendingMeta = this.writeMeta(wavPath, open, 0, false).catch(
        (error: unknown) => this.fail(error),
      );
    }
    this.writing = plan.write;
  }

  private async finalizeOpen(): Promise<void> {
    const open = this.current;
    const stream = this.stream;
    const wavPath = this.wavPath;
    if (!open || !stream || !wavPath) {
      this.clearOpenSegment();
      return;
    }
    // A bounded pending-metadata write must settle before the complete record
    // so it can never land after (and overwrite) it.
    await this.pendingMeta;
    this.pendingMeta = null;
    // Pushes stop before finalize (writing is false), so this drain is at most
    // the in-flight write plus one coalesced write, each individually bounded.
    await this.flush();
    const samplesWritten = this.samples;
    if (this.failure) {
      await this.closeBounded(stream, samplesWritten);
      this.clearOpenSegment();
      return;
    }
    let closing = false;
    try {
      await this.bounded(
        stream.write(
          pcmWavHeader(
            samplesWritten * BYTES_PER_SAMPLE,
            KEEPER_SAMPLE_RATE,
            1,
          ),
          0,
        ),
        "final header write",
      );
      closing = true;
      await this.bounded(
        stream.close(),
        "close",
        this.closeTimeoutMs(samplesWritten),
      );
    } catch (error) {
      this.fail(error);
      if (!closing) {
        await this.closeBounded(stream, samplesWritten);
      }
      this.clearOpenSegment();
      return;
    }
    try {
      const wav = await this.bounded(this.sink.read(wavPath), "final WAV read");
      if (
        !wav ||
        wav.byteLength !== WAV_HEADER_BYTES + samplesWritten * BYTES_PER_SAMPLE
      ) {
        throw new Error(
          "The finalized keeper WAV changed before metadata was written.",
        );
      }
      const fileSha256 = await this.bounded(sha256Hex(wav), "final WAV hash");
      await this.writeMeta(wavPath, open, samplesWritten, true, {
        fileSha256,
        byteLength: wav.byteLength,
      });
    } catch (error) {
      // The WAV is already closed and complete, so metadata that lands after
      // the deadline still forms a consistent pair that upload may pick up.
      // This is only safe because applyLocked reserves the segment index
      // before opening it: no later segment can ever share this path.
      this.fail(error);
      this.clearOpenSegment();
      throw error;
    }
    this.clearOpenSegment();
  }

  private async writeMeta(
    wavPath: string,
    open: OpenSegment,
    samplesWritten: number,
    complete: boolean,
    fingerprint?: Pick<KeeperMeta, "fileSha256" | "byteLength">,
  ): Promise<void> {
    const meta: KeeperMeta = {
      sessionId: this.sessionId,
      takeIndex: open.takeIndex,
      participantId: this.participantId,
      segmentIndex: open.segmentIndex,
      sampleRate: KEEPER_SAMPLE_RATE,
      joinOffsetMs: open.joinOffsetMs,
      samplesWritten,
      complete,
      ...fingerprint,
    };
    await this.bounded(
      writeKeeperMeta(this.sink, wavPath, meta),
      complete ? "metadata write" : "pending metadata write",
    );
    if (complete) {
      this.files.push(meta);
    }
  }

  /** Release a failed writable, waiting no longer than its close deadline. */
  private async closeBounded(
    stream: ByteStream,
    samples: number,
  ): Promise<void> {
    try {
      await this.bounded(
        Promise.resolve().then(() => stream.close()),
        "close",
        this.closeTimeoutMs(samples),
      );
    } catch {
      // A faulty or hung sink must not block retry or teardown past the limit.
    }
  }

  private closeTimeoutMs(samples: number): number {
    return (
      this.operationTimeoutMs +
      Math.ceil((samples * BYTES_PER_SAMPLE) / this.closeBytesPerMs)
    );
  }

  /**
   * Race an OPFS operation against a wall-clock limit. The operation itself is
   * not cancelled; callers rely on `epoch` to ignore its late completion.
   */
  private async bounded<T>(
    operation: Promise<T>,
    label: string,
    timeoutMs = this.operationTimeoutMs,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new KeeperStallError(
              `keeper ${label} timed out after ${timeoutMs}ms`,
            ),
          ),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private clearOpenSegment(): void {
    this.current = null;
    this.stream = null;
    this.wavPath = null;
    this.samples = 0;
    this.resetQueue();
  }

  /** Drop queued PCM and invalidate any in-flight write. */
  private resetQueue(): void {
    this.epoch += 1;
    this.pending = [];
    this.pendingSamples = 0;
    this.inFlightSamples = 0;
    this.draining = false;
  }

  private fail(error: unknown): void {
    if (this.failure) {
      return;
    }
    this.failure = error instanceof Error ? error : new Error(String(error));
    this.writing = false;
    this.cursor = { ...this.cursor, open: null };
    this.resetQueue();
    this.onFailure?.(this.failure);
  }
}
