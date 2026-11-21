import type { ClipRow } from "../types/project";
import { dbToLinear, trackIsAudible, trackOutputGainDb } from "../utils/audio";
import { createChannelPeakTap } from "./channelPeakTap";
import {
  effectiveGainAt,
  gainBreakpoints,
  type VolumePoint,
} from "./gainCurve";
import {
  enterPlaybackSession,
  leavePlaybackSession,
  releasePlaybackSession,
} from "./playbackSession";
import {
  buildSchedule,
  chunkRefKey,
  episodeEndSec,
  type ImmutableChunkRef,
  type ProxyManifest,
  type ScheduledSlice,
} from "./proxyMath";

export interface TrackInfo {
  id: string;
  gain_db: number;
  fader_db?: number;
  muted: boolean;
}

const WINDOW_PAD_SEC = 120;
const LOW_WATER_CTX_SEC = 45;
/** A failing extension is retried until this much scheduled sound is left, then reported. */
const RETRY_GIVE_UP_SEC = 5;
const RETRY_BACKOFF_MAX_SEC = 4;
const LATE_EXTENSION_GRACE_CTX_SEC = 1;
/** Time constant for a live gain change (reaches ~99% in 5x this). */
const GAIN_GLIDE_SEC = 0.01;
/** Decoded audio kept behind the playhead, so a short skip back during continuous play needs no fetch or decode. */
const SKIP_BACK_KEEP_SEC = 30;
const LRU_BUDGET_BYTES = 500 * 1024 * 1024;

export interface ProxyPlaybackSnapshot {
  readonly manifest: ProxyManifest;
  readonly clipsByTrack: Readonly<Record<string, readonly ClipRow[]>>;
  readonly tracks: readonly TrackInfo[];
  /** Each track's volume envelope points by track id, sorted by time. */
  readonly volumeByTrack?: Readonly<Record<string, readonly VolumePoint[]>>;
  /** The stored timeline duration; the episode ends no earlier. Infinity when unknown, which never ends it. */
  readonly durationSec: number;
  readonly playUntilSec: number | null;
}

type FetchChunk = (ref: ImmutableChunkRef) => Promise<ArrayBuffer>;
type ChunkFailure = (error: unknown, ref: ImmutableChunkRef | null) => void;
type EpisodeEnded = (endSec: number) => void;

export interface ProxyEngineEvents {
  onFailure: ChunkFailure;
  onEnded: EpisodeEnded;
  /** The sound stopped without a command: the OS paused the keep-alive, or the audio context left "running". */
  onSinkStopped: () => void;
  /** The OS resumed the keep-alive after the app had left (a call or Siri ended). */
  onSystemPlay: () => void;
}

class ChunkFetchError extends Error {
  readonly ref: ImmutableChunkRef;

  constructor(ref: ImmutableChunkRef, cause: unknown) {
    super("chunk fetch failed", { cause });
    this.ref = ref;
  }
}

interface ExtendRetry {
  attempt: number;
  wakeSec: number;
  /** The first attempt's batch end, so a retry asks for the same chunks. */
  batchEndSec: number;
  error: unknown;
  ref: ImmutableChunkRef;
}

interface Horizon {
  readonly generation: number;
  pendingUntilTimelineSec: number | null;
  retry: ExtendRetry | null;
  /**
   * Timeline seconds, exclusive. Every slice that starts before it has exactly
   * one source in this generation; no slice that starts at or after it has one.
   */
  throughSec: number;
}

interface ActiveSource {
  source: AudioBufferSourceNode;
  gain: GainNode;
  endCtxTime: number;
}

function bufferBytes(buf: AudioBuffer): number {
  return buf.length * buf.numberOfChannels * 4;
}

export class ProxyEngine {
  private ctx: AudioContext;
  private fetchChunk: FetchChunk;
  private snapshot: ProxyPlaybackSnapshot | null = null;
  private scheduleKey = "";
  private endSec = Number.POSITIVE_INFINITY;
  private tracks: readonly TrackInfo[] = [];
  private events: ProxyEngineEvents;
  private buffers = new Map<string, AudioBuffer>();
  private lru: string[] = [];
  private decodedBytes = 0;
  private trackGains = new Map<string, GainNode>();
  private meterTaps = new Map<
    string,
    ReturnType<typeof createChannelPeakTap>
  >();
  private master: GainNode;
  private active: ActiveSource[] = [];
  private playing = false;
  /** True once this play's `resume()` settled, so a late `statechange` from the previous pause reads as ours. */
  private sinkRunning = false;
  private playToken = 0;
  private readonly sessionEvents = {
    onSystemPause: () => this.events.onSinkStopped(),
    onSystemPlay: () => this.events.onSystemPlay(),
  };
  private horizon: Horizon | null = null;
  private sentinel: ConstantSourceNode | null = null;
  private playbackRate = 1;
  private scheduleGeneration = 0;
  private loadingBuffers = new Map<string, Promise<AudioBuffer | null>>();
  private originCtxTime = 0;
  private originTimelineSec = 0;
  private solo: Record<string, boolean> = {};
  private listenMute: Record<string, boolean> = {};

  constructor(
    ctx: AudioContext,
    fetchChunk: FetchChunk,
    events: ProxyEngineEvents,
  ) {
    this.ctx = ctx;
    this.fetchChunk = fetchChunk;
    this.events = events;
    ctx.addEventListener("statechange", this.onContextStateChange);
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
  }

  setSnapshot(snapshot: ProxyPlaybackSnapshot): void {
    const { tracks, manifest, clipsByTrack, volumeByTrack } = snapshot;
    const endSec = episodeEndSec(snapshot.durationSec, clipsByTrack);
    const scheduleKey = JSON.stringify([
      manifest.tracks,
      manifest.artifacts,
      manifest.occurrences,
      clipsByTrack,
      volumeByTrack,
      endSec,
      snapshot.playUntilSec,
    ]);
    const changed = scheduleKey !== this.scheduleKey;
    const now = this.currentTimeSec();
    this.scheduleKey = scheduleKey;
    this.snapshot = snapshot;
    this.endSec = endSec;
    this.tracks = tracks;
    for (const t of tracks) {
      if (!this.trackGains.has(t.id)) {
        const g = this.ctx.createGain();
        // Start silent: applyGains glides it up, so a muted new track never
        // leaks through.
        g.gain.value = 0;
        g.connect(this.master);
        this.trackGains.set(t.id, g);
      }
    }
    for (const [id, gain] of this.trackGains) {
      if (tracks.some((track) => track.id === id)) continue;
      this.meterTaps.get(id)?.dispose();
      this.meterTaps.delete(id);
      gain.disconnect();
      this.trackGains.delete(id);
    }
    this.applyGains();
    // A volume or mute change only moves gains; new clips need new sources.
    if (changed) {
      this.beginScheduleGeneration();
      this.horizon = null;
      this.stopSources();
      if (this.playing) {
        this.originTimelineSec = now;
        this.originCtxTime = this.ctx.currentTime;
        this.schedule(now);
      }
    }
  }

  private get stopSec(): number {
    const until = this.snapshot?.playUntilSec;
    return until != null && Number.isFinite(until)
      ? Math.min(this.endSec, until)
      : this.endSec;
  }

  /** Listen-only solo: this listener hears only the soloed tracks. */
  setSolo(soloTracks: Record<string, boolean>): void {
    this.solo = { ...soloTracks };
    this.applyGains();
  }

  /** Listen-only mutes (guests without edit); the saved mute rides on tracks. */
  setListenMute(listenMute: Record<string, boolean>): void {
    this.listenMute = { ...listenMute };
    this.applyGains();
  }

  /** Every track at its output gain (staging + volume) unless silenced. */
  private applyGains(): void {
    const now = this.ctx.currentTime;
    for (const t of this.tracks) {
      const g = this.trackGains.get(t.id);
      if (!g) {
        continue;
      }
      const audible = trackIsAudible(t.id, t.muted, this.listenMute, this.solo);
      const target = audible ? dbToLinear(trackOutputGainDb(t)) : 0;
      g.gain.cancelScheduledValues(now);
      if (this.playing) {
        // Glide to a live change so it doesn't click.
        g.gain.setTargetAtTime(target, now, GAIN_GLIDE_SEC);
      } else {
        g.gain.value = target;
      }
    }
  }

  play(fromTimelineSec: number): void {
    if (fromTimelineSec >= this.endSec) fromTimelineSec = 0;
    this.playing = true;
    this.originTimelineSec = fromTimelineSec;
    this.originCtxTime = this.ctx.currentTime;
    // iPhone mutes Web Audio on the silent switch unless the page is in a playback session.
    enterPlaybackSession(this.sessionEvents);
    this.sinkRunning = false;
    const token = ++this.playToken;
    this.ctx
      .resume()
      .then(() => {
        if (
          this.playing &&
          token === this.playToken &&
          this.ctx.state === "running"
        )
          this.sinkRunning = true;
      })
      .catch(() => undefined);
    this.schedule(fromTimelineSec);
  }

  setPlaybackRate(rate: number): void {
    if (rate === this.playbackRate) return;
    const at = this.currentTimeSec();
    this.originTimelineSec = at;
    this.originCtxTime = this.ctx.currentTime;
    this.playbackRate = rate;
    if (this.playing) {
      this.stopSources();
      this.schedule(at);
    }
  }

  pause(): number {
    const t = this.currentTimeSec();
    this.playing = false;
    this.sinkRunning = false;
    this.horizon = null;
    this.beginScheduleGeneration();
    this.stopSources();
    this.originTimelineSec = t;
    this.pruneBuffers(t - SKIP_BACK_KEEP_SEC, t + WINDOW_PAD_SEC);
    leavePlaybackSession();
    void this.ctx.suspend();
    return t;
  }

  seek(timelineSec: number): void {
    const wasPlaying = this.playing;
    this.beginScheduleGeneration();
    this.horizon = null;
    this.stopSources();
    this.originTimelineSec = timelineSec;
    this.originCtxTime = this.ctx.currentTime;
    if (wasPlaying) {
      this.schedule(timelineSec);
    }
  }

  currentTimeSec(): number {
    if (!this.playing) {
      return this.originTimelineSec;
    }
    return Math.min(
      this.stopSec,
      this.originTimelineSec +
        (this.ctx.currentTime - this.originCtxTime) * this.playbackRate,
    );
  }

  private get scheduleReady(): boolean {
    return this.horizon !== null;
  }

  readTrackFrame(trackId: string): ArrayLike<number> | null {
    if (
      this.ctx.state !== "running" ||
      !this.playing ||
      !this.scheduleReady ||
      !this.snapshot
    )
      return null;
    const gain = this.trackGains.get(trackId);
    if (!gain) return null;
    try {
      let tap = this.meterTaps.get(trackId);
      if (!tap) {
        tap = createChannelPeakTap(this.ctx, gain);
        this.meterTaps.set(trackId, tap);
      }
      return tap.read();
    } catch {
      return null;
    }
  }

  private onContextStateChange = (): void => {
    if (!this.playing || !this.sinkRunning || this.ctx.state === "running")
      return;
    this.sinkRunning = false;
    this.events.onSinkStopped();
  };

  dispose(): void {
    this.ctx.removeEventListener("statechange", this.onContextStateChange);
    this.pause();
    releasePlaybackSession(this.sessionEvents);
    for (const tap of this.meterTaps.values()) tap.dispose();
    this.meterTaps.clear();
    for (const gain of this.trackGains.values()) gain.disconnect();
    this.trackGains.clear();
    this.master.disconnect();
    void this.ctx.close();
    this.buffers.clear();
    this.lru = [];
    this.decodedBytes = 0;
  }

  private stopSources(): void {
    this.disarm();
    for (const a of this.active) {
      try {
        a.source.stop();
      } catch {
        /* already stopped */
      }
      try {
        a.source.disconnect();
        a.gain.disconnect();
      } catch {
        /* ignore */
      }
    }
    this.active = [];
  }

  private touchLru(key: string, bytes: number): void {
    const i = this.lru.indexOf(key);
    if (i >= 0) {
      this.lru.splice(i, 1);
    } else {
      this.decodedBytes += bytes;
    }
    this.lru.push(key);
    while (this.decodedBytes > LRU_BUDGET_BYTES && this.lru.length > 1) {
      const evict = this.lru.shift();
      if (!evict) {
        break;
      }
      const buf = this.buffers.get(evict);
      if (buf) {
        this.decodedBytes -= bufferBytes(buf);
        this.buffers.delete(evict);
      }
    }
  }

  /**
   * In-flight chunks are not in `buffers`, and sounding sources hold their own buffer.
   * Clips the manifest does not cover yet keep nothing: pruning must not throw into
   * pause, dispose or the pump, and playing them reports the failure itself.
   */
  private pruneBuffers(fromSec: number, toSec: number): void {
    const snapshot = this.snapshot;
    const keep = new Set<string>();
    if (snapshot)
      for (const slice of this.slicesBetween(snapshot, fromSec, toSec, "skip"))
        keep.add(chunkRefKey(slice.chunk));
    for (const [key, buf] of this.buffers) {
      if (keep.has(key)) continue;
      this.buffers.delete(key);
      this.decodedBytes -= bufferBytes(buf);
      const i = this.lru.indexOf(key);
      if (i >= 0) this.lru.splice(i, 1);
    }
  }

  private async ensureBuffer(
    ref: ImmutableChunkRef,
    generation: number,
  ): Promise<AudioBuffer | null> {
    if (generation !== this.scheduleGeneration) return null;
    const key = chunkRefKey(ref);
    const existing = this.buffers.get(key);
    if (existing) {
      this.touchLru(key, 0);
      return existing;
    }
    const loading = this.loadingBuffers;
    const pending = loading.get(key);
    if (pending) return pending;
    const request = this.loadBuffer(ref, key, generation).finally(() => {
      loading.delete(key);
    });
    loading.set(key, request);
    return request;
  }

  private async loadBuffer(
    ref: ImmutableChunkRef,
    key: string,
    generation: number,
  ): Promise<AudioBuffer | null> {
    let ab: ArrayBuffer;
    try {
      ab = await this.fetchChunk(ref);
    } catch (error) {
      if (generation !== this.scheduleGeneration) return null;
      throw new ChunkFetchError(ref, error);
    }
    if (generation !== this.scheduleGeneration) return null;
    try {
      const buf = await this.ctx.decodeAudioData(ab.slice(0));
      if (generation !== this.scheduleGeneration) return null;
      this.buffers.set(key, buf);
      this.touchLru(key, bufferBytes(buf));
      return buf;
    } catch (error) {
      this.fail(generation, error, ref);
      return null;
    }
  }

  private fail(
    generation: number,
    error: unknown,
    ref: ImmutableChunkRef | null,
  ): void {
    if (!this.playing || generation !== this.scheduleGeneration) return;
    if (error instanceof ChunkFetchError) {
      ref = error.ref;
      error = error.cause;
    }
    const stopSec = this.stopSec;
    if (Number.isFinite(stopSec) && this.currentTimeSec() >= stopSec) {
      this.finish();
      return;
    }
    this.pause();
    this.events.onFailure(error, ref);
  }

  private applyFades(
    gain: GainNode,
    slice: ScheduledSlice,
    when: number,
  ): void {
    const start = Math.max(when, this.ctx.currentTime);
    const end = when + slice.durationSec / this.playbackRate;
    const clip = slice.envelope;
    const timelineAt = (at: number) =>
      slice.whenTimelineSec + (at - when) * this.playbackRate;
    const startTimeline = timelineAt(start);
    const endTimeline = timelineAt(end);
    const points = [
      start,
      ...gainBreakpoints(clip.volume, clip, startTimeline, endTimeline).map(
        (timeline) =>
          when + (timeline - slice.whenTimelineSec) / this.playbackRate,
      ),
      end,
    ];
    gain.gain.cancelScheduledValues(start);
    gain.gain.setValueAtTime(
      effectiveGainAt(clip.volume, clip, startTimeline),
      start,
    );
    for (const point of points.slice(1))
      gain.gain.linearRampToValueAtTime(
        effectiveGainAt(clip.volume, clip, timelineAt(point)),
        point,
      );
  }

  private schedule(timelineSec: number): void {
    const generation = this.scheduleGeneration + 1;
    void this.scheduleAround(timelineSec).catch((error: unknown) => {
      this.fail(generation, error, null);
    });
  }

  private beginScheduleGeneration(): number {
    this.loadingBuffers = new Map();
    return ++this.scheduleGeneration;
  }

  private slicesBetween(
    snapshot: ProxyPlaybackSnapshot,
    startSec: number,
    endSec: number,
    onMissing: "throw" | "skip" = "throw",
  ): ScheduledSlice[] {
    return Object.values(snapshot.clipsByTrack).flatMap((clips) =>
      buildSchedule(
        clips,
        startSec,
        endSec,
        snapshot.manifest,
        snapshot.volumeByTrack,
        onMissing,
      ),
    );
  }

  private decodeInto(
    decoded: Map<string, AudioBuffer>,
    slices: readonly ScheduledSlice[],
    generation: number,
  ): Promise<unknown> {
    const needed = new Map(
      slices.map((slice) => [chunkRefKey(slice.chunk), slice.chunk]),
    );
    return Promise.all(
      [...needed].map(async ([key, ref]) => {
        const buf = await this.ensureBuffer(ref, generation);
        if (buf) decoded.set(key, buf);
      }),
    );
  }

  private async scheduleAround(timelineSec: number): Promise<void> {
    this.horizon = null;
    const generation = this.beginScheduleGeneration();
    const snapshot = this.snapshot;
    if (!snapshot || !this.playing) return;
    // A slice that straddles the target is still included; nothing before it can sound.
    const windowEnd = Math.min(timelineSec + WINDOW_PAD_SEC, this.stopSec);
    this.arm();
    const slices =
      windowEnd > timelineSec
        ? this.slicesBetween(snapshot, timelineSec, windowEnd)
        : [];
    const decoded = new Map<string, AudioBuffer>();
    await this.decodeInto(decoded, slices, generation);
    if (!this.playing || generation !== this.scheduleGeneration) return;
    if (this.currentTimeSec() >= this.stopSec) {
      this.finish();
      return;
    }
    this.stopSources();
    this.place(slices, decoded, this.currentTimeSec());
    this.horizon = {
      generation,
      throughSec: windowEnd,
      pendingUntilTimelineSec: null,
      retry: null,
    };
    this.pruneBuffers(this.currentTimeSec() - SKIP_BACK_KEEP_SEC, windowEnd);
    this.arm();
  }

  private place(
    slices: readonly ScheduledSlice[],
    decoded: ReadonlyMap<string, AudioBuffer>,
    timelineSec: number,
  ): void {
    const nowCtx = this.ctx.currentTime;
    for (const slice of slices) {
      const buf = decoded.get(chunkRefKey(slice.chunk));
      const trackGain = this.trackGains.get(slice.outputTrackId);
      if (!buf || !trackGain) continue;
      const when =
        nowCtx + (slice.whenTimelineSec - timelineSec) / this.playbackRate;
      if (when + slice.durationSec / this.playbackRate <= nowCtx) continue;
      if (slice.whenTimelineSec >= this.stopSec) continue;
      const source = this.ctx.createBufferSource();
      source.buffer = buf;
      source.playbackRate.value = this.playbackRate;
      const clipGain = this.ctx.createGain();
      source.connect(clipGain);
      clipGain.connect(trackGain);
      this.applyFades(clipGain, slice, when);
      const skipped = Math.max(0, (nowCtx - when) * this.playbackRate);
      const playSec = slice.durationSec - skipped;
      try {
        source.start(
          Math.max(when, nowCtx),
          slice.bufferOffsetSec + skipped,
          playSec,
        );
        if (slice.whenTimelineSec + slice.durationSec > this.stopSec)
          source.stop(
            this.originCtxTime +
              (this.stopSec - this.originTimelineSec) / this.playbackRate,
          );
      } catch {
        source.disconnect();
        clipGain.disconnect();
        continue;
      }
      this.active.push({
        source,
        gain: clipGain,
        endCtxTime: Math.max(when, nowCtx) + playSec / this.playbackRate,
      });
    }
  }

  private async extend(horizon: Horizon): Promise<void> {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    const { generation } = horizon;
    // From the old edge, not the playhead: a late wake still gets the slices that should already be sounding.
    const from = horizon.throughSec;
    const t = this.currentTimeSec();
    const to =
      horizon.retry?.batchEndSec ??
      Math.min(
        this.stopSec,
        Math.max(from, t) +
          Math.max(WINDOW_PAD_SEC, 2 * LOW_WATER_CTX_SEC * this.playbackRate),
      );
    // A slice that straddles `from` already has its source from the earlier batch;
    // one that has already ended is not worth fetching after a late wake.
    const slices = this.slicesBetween(snapshot, from, to).filter(
      (slice) =>
        slice.whenTimelineSec >= from &&
        slice.whenTimelineSec + slice.durationSec > t,
    );
    const decoded = new Map<string, AudioBuffer>();
    horizon.pendingUntilTimelineSec = this.extensionDeadlineSec(horizon, t);
    this.arm();
    try {
      await this.decodeInto(decoded, slices, generation);
    } catch (error) {
      horizon.pendingUntilTimelineSec = null;
      if (!this.playing || generation !== this.scheduleGeneration) return;
      if (!(error instanceof ChunkFetchError)) throw error;
      this.retryLater(horizon, error, to);
      return;
    }
    horizon.pendingUntilTimelineSec = null;
    if (!this.playing || generation !== this.scheduleGeneration) return;
    horizon.retry = null;
    this.place(slices, decoded, this.currentTimeSec());
    horizon.throughSec = to;
    this.pruneBuffers(this.currentTimeSec() - SKIP_BACK_KEEP_SEC, to);
    this.arm();
  }

  private retryLater(
    horizon: Horizon,
    error: ChunkFetchError,
    batchEndSec: number,
  ): void {
    const t = this.currentTimeSec();
    const giveUpSec = this.giveUpPointSec(horizon);
    if (t >= giveUpSec) {
      this.fail(horizon.generation, error, null);
      return;
    }
    const attempt = horizon.retry?.attempt ?? 0;
    const backoffSec = Math.min(2 ** attempt, RETRY_BACKOFF_MAX_SEC);
    horizon.retry = {
      attempt: attempt + 1,
      wakeSec: Math.min(t + backoffSec * this.playbackRate, giveUpSec),
      batchEndSec,
      error: error.cause,
      ref: error.ref,
    };
    this.arm();
  }

  private giveUpPointSec(horizon: Horizon): number {
    return horizon.throughSec - RETRY_GIVE_UP_SEC * this.playbackRate;
  }

  private extensionDeadlineSec(horizon: Horizon, t: number): number {
    const giveUpSec = this.giveUpPointSec(horizon);
    if (t < giveUpSec) return giveUpSec;
    const until = this.snapshot?.playUntilSec;
    if (until != null && Number.isFinite(until)) return this.stopSec;
    return Math.max(
      horizon.throughSec,
      t + LATE_EXTENSION_GRACE_CTX_SEC * this.playbackRate,
    );
  }

  private wakeTimelineSec(): number {
    const horizon = this.horizon;
    const stopSec = this.stopSec;
    if (!horizon) return stopSec;
    const due =
      horizon.pendingUntilTimelineSec ??
      horizon.retry?.wakeSec ??
      (horizon.throughSec >= stopSec
        ? stopSec
        : horizon.throughSec - LOW_WATER_CTX_SEC * this.playbackRate);
    return Math.min(stopSec, due);
  }

  /** Wakes the engine from the audio clock, which keeps running when timers and frames are throttled. */
  private arm(): void {
    this.disarm();
    const generation = this.scheduleGeneration;
    const wakeTimelineSec = this.wakeTimelineSec();
    if (!Number.isFinite(wakeTimelineSec)) return;
    if (this.currentTimeSec() >= wakeTimelineSec) {
      queueMicrotask(() => {
        if (generation === this.scheduleGeneration) this.pump();
      });
      return;
    }
    const sentinel = this.ctx.createConstantSource();
    sentinel.offset.value = 0;
    sentinel.connect(this.master);
    sentinel.onended = () => {
      if (generation === this.scheduleGeneration) this.pump();
    };
    sentinel.start();
    sentinel.stop(
      this.originCtxTime +
        (wakeTimelineSec - this.originTimelineSec) / this.playbackRate,
    );
    this.sentinel = sentinel;
  }

  private disarm(): void {
    const sentinel = this.sentinel;
    if (!sentinel) return;
    this.sentinel = null;
    // stop() raises `ended` too, so detach the handler first.
    sentinel.onended = null;
    try {
      sentinel.stop();
    } catch {
      /* already stopped */
    }
    sentinel.disconnect();
  }

  private pump(): void {
    const horizon = this.horizon;
    if (!this.playing) return;
    this.pruneEnded();
    const t = this.currentTimeSec();
    if (t >= this.stopSec) {
      this.finish();
      return;
    }
    if (!horizon) {
      this.arm();
      return;
    }
    this.pruneBuffers(
      t - SKIP_BACK_KEEP_SEC,
      Math.max(t, horizon.retry?.batchEndSec ?? horizon.throughSec),
    );
    if (t < this.wakeTimelineSec()) {
      this.arm();
      return;
    }
    if (
      horizon.pendingUntilTimelineSec !== null ||
      (horizon.retry !== null && t >= this.giveUpPointSec(horizon))
    ) {
      this.fail(
        horizon.generation,
        horizon.retry?.error ?? new Error("chunk fetch timed out"),
        horizon.retry?.ref ?? null,
      );
      return;
    }
    void this.extend(horizon).catch((error: unknown) => {
      this.fail(horizon.generation, error, null);
    });
  }

  private pruneEnded(): void {
    const now = this.ctx.currentTime;
    this.active = this.active.filter((a) => {
      if (a.endCtxTime > now) return true;
      try {
        a.source.disconnect();
        a.gain.disconnect();
      } catch {
        /* ignore */
      }
      return false;
    });
  }

  private finish(): void {
    this.events.onEnded(this.pause());
  }
}
