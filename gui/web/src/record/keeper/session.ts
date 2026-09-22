import { pcmWavHeader } from "../../audio/wavHeader";
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
  keeperMetaPath,
  keeperWavPath,
} from "./store";

export const KEEPER_MAX_QUEUED_SAMPLES = KEEPER_SAMPLE_RATE * 4;
export const KEEPER_OPERATION_TIMEOUT_MS = 5_000;

export type KeeperSessionOptions = {
  maxQueuedSamples?: number;
  operationTimeoutMs?: number;
};

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`keeper ${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function closeBestEffort(stream: ByteStream): void {
  try {
    void stream.close().catch(() => undefined);
  } catch {
    // A faulty sink must not prevent retry or teardown from progressing.
  }
}

export class KeeperSession {
  private cursor = emptyKeeperCursor();
  private samples = 0;
  private writing = false;
  private muted = false;
  private current: OpenSegment | null = null;
  private stream: ByteStream | null = null;
  private wavPath: string | null = null;
  private sessionId = "";
  private participantId = "";
  private writeChain: Promise<void> = Promise.resolve();
  private queuedSamples = 0;
  private generation = 0;
  private failure: Error | null = null;
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
    const next = await this.sink.nextSegmentIndex(
      sessionId,
      takeIndex,
      participantId,
    );
    this.sessionId = sessionId;
    this.participantId = participantId;
    this.cursor = {
      takeIndex,
      nextSegmentIndex: next,
      open: null,
    };
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
    if (this.queuedSamples + int16.length > this.maxQueuedSamples) {
      this.fail(
        new Error(
          `keeper PCM backlog exceeded ${this.maxQueuedSamples} samples`,
        ),
      );
      return;
    }
    const offset = 44 + (this.samples + this.queuedSamples) * 2;
    this.queuedSamples += int16.length;
    const bytes = new Uint8Array(
      int16.buffer,
      int16.byteOffset,
      int16.byteLength,
    );
    const stream = this.stream;
    const generation = this.generation;
    this.writeChain = this.writeChain
      .then(
        async () => {
          if (
            this.failure ||
            this.stream !== stream ||
            generation !== this.generation
          ) {
            return;
          }
          await withTimeout(
            stream.write(bytes, offset),
            this.operationTimeoutMs,
            "write",
          );
          if (generation !== this.generation || this.stream !== stream) {
            return;
          }
          this.samples += int16.length;
          this.queuedSamples = Math.max(0, this.queuedSamples - int16.length);
        },
        (error: unknown) => {
          if (generation === this.generation) {
            this.fail(error);
          }
        },
      )
      .catch((error: unknown) => {
        if (generation === this.generation) {
          this.fail(error);
        }
      });
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  async dispose(): Promise<void> {
    await this.lock(async () => {
      this.writing = false;
      await this.finalizeOpen();
      this.cursor = emptyKeeperCursor();
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
    // reusing its path.
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
        this.stream = await withTimeout(
          opened,
          this.operationTimeoutMs,
          "open",
        );
        await withTimeout(
          this.stream.write(pcmWavHeader(0, KEEPER_SAMPLE_RATE, 1), 0),
          this.operationTimeoutMs,
          "header write",
        );
      } catch (error) {
        this.fail(error);
        if (this.stream) {
          closeBestEffort(this.stream);
        } else if (opened) {
          void opened.then(closeBestEffort, () => undefined);
        }
        this.clearOpenSegment();
        throw error;
      }
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
    await this.flush();
    const samplesWritten = this.samples;
    if (this.failure) {
      closeBestEffort(stream);
      this.clearOpenSegment();
      return;
    }
    try {
      await withTimeout(
        stream.write(
          pcmWavHeader(samplesWritten * 2, KEEPER_SAMPLE_RATE, 1),
          0,
        ),
        this.operationTimeoutMs,
        "final header write",
      );
      await withTimeout(stream.close(), this.operationTimeoutMs, "close");
    } catch (error) {
      this.fail(error);
      closeBestEffort(stream);
      this.clearOpenSegment();
      return;
    }
    const meta: KeeperMeta = {
      sessionId: this.sessionId,
      takeIndex: open.takeIndex,
      participantId: this.participantId,
      segmentIndex: open.segmentIndex,
      sampleRate: KEEPER_SAMPLE_RATE,
      joinOffsetMs: open.joinOffsetMs,
      samplesWritten,
    };
    const json = new TextEncoder().encode(`${JSON.stringify(meta, null, 2)}\n`);
    const metaPath = keeperMetaPath(wavPath);
    let metadataWrite: Promise<void> | null = null;
    try {
      metadataWrite = this.sink.write(metaPath, json);
      await withTimeout(
        metadataWrite,
        this.operationTimeoutMs,
        "metadata write",
      );
    } catch (error) {
      if (metadataWrite) {
        void metadataWrite
          .then(
            () => this.sink.remove(metaPath),
            () => undefined,
          )
          .catch(() => undefined);
      }
      this.fail(error);
      this.clearOpenSegment();
      throw error;
    }
    this.files.push(meta);
    this.clearOpenSegment();
  }

  private clearOpenSegment(): void {
    this.current = null;
    this.stream = null;
    this.wavPath = null;
    this.samples = 0;
    this.queuedSamples = 0;
  }

  private fail(error: unknown): void {
    if (this.failure) {
      return;
    }
    this.failure = error instanceof Error ? error : new Error(String(error));
    this.generation += 1;
    this.writing = false;
    this.cursor = { ...this.cursor, open: null };
    this.queuedSamples = 0;
    this.onFailure?.(this.failure);
  }
}
