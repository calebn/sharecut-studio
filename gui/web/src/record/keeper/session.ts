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
  private mutex: Promise<void> = Promise.resolve();
  readonly files: KeeperMeta[] = [];
  private readonly sink: ByteSink;

  constructor(sink: ByteSink) {
    this.sink = sink;
  }

  get isWriting(): boolean {
    return this.writing;
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
    await this.lock(() => this.applyLocked(gate));
  }

  push(pcm: Float32Array, sourceRate: number): void {
    if (!this.writing || !this.current || !this.stream) {
      return;
    }
    const int16 = toKeeperPcm(pcm, sourceRate, this.muted);
    const offset = 44 + this.samples * 2;
    this.samples += int16.length;
    const bytes = new Uint8Array(
      int16.buffer,
      int16.byteOffset,
      int16.byteLength,
    );
    const stream = this.stream;
    this.writeChain = this.writeChain.then(() => stream.write(bytes, offset));
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
    const plan = planKeeperSegment(gate, this.cursor);
    this.writing = false;
    if (plan.close) {
      await this.finalizeOpen();
    }
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
      this.stream = await this.sink.open(wavPath);
      await this.stream.write(pcmWavHeader(0, KEEPER_SAMPLE_RATE, 1), 0);
    }
    this.writing = plan.write;
  }

  private async finalizeOpen(): Promise<void> {
    const open = this.current;
    const stream = this.stream;
    const wavPath = this.wavPath;
    if (!open || !stream || !wavPath) {
      this.current = null;
      this.stream = null;
      this.wavPath = null;
      return;
    }
    await this.flush();
    const samplesWritten = this.samples;
    await stream.write(
      pcmWavHeader(samplesWritten * 2, KEEPER_SAMPLE_RATE, 1),
      0,
    );
    await stream.close();
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
    await this.sink.write(keeperMetaPath(wavPath), json);
    this.files.push(meta);
    this.current = null;
    this.stream = null;
    this.wavPath = null;
    this.samples = 0;
  }
}
