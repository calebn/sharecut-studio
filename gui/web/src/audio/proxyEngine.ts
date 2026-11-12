import type { ClipRow } from "../types/project";
import { dbToLinear, trackIsAudible, trackOutputGainDb } from "../utils/audio";
import { createChannelPeakTap } from "./channelPeakTap";
import {
  effectiveGainAt,
  gainBreakpoints,
  type VolumePoint,
} from "./gainCurve";
import { enterPlaybackSession, leavePlaybackSession } from "./playbackSession";
import {
  buildSchedule,
  chunkRefKey,
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
/** Sound scheduled ahead of the playhead, in audio-clock seconds, below which the engine schedules more. */
const LOW_WATER_CTX_SEC = 45;
/** Time constant for a live gain change (reaches ~99% in 5x this). */
const GAIN_GLIDE_SEC = 0.01;
const LRU_BUDGET_BYTES = 500 * 1024 * 1024;

export interface ProxyPlaybackSnapshot {
  readonly manifest: ProxyManifest;
  readonly clipsByTrack: Readonly<Record<string, readonly ClipRow[]>>;
  readonly tracks: readonly TrackInfo[];
  /** Each track's volume envelope points by track id, sorted by time. */
  readonly volumeByTrack?: Readonly<Record<string, readonly VolumePoint[]>>;
  /** The timeline's end; Infinity when unknown, which never ends the episode. */
  readonly durationSec: number;
}

type FetchChunk = (ref: ImmutableChunkRef) => Promise<ArrayBuffer>;
type ChunkFailure = (error: unknown, ref: ImmutableChunkRef | null) => void;
type EpisodeEnded = (endSec: number) => void;

/** Where sound is scheduled right now; it exists only between a finished (re)schedule and the next stop. */
interface Horizon {
  readonly generation: number;
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

export class ProxyEngine {
  private ctx: AudioContext;
  private fetchChunk: FetchChunk;
  private snapshot: ProxyPlaybackSnapshot | null = null;
  private scheduleKey = "";
  private tracks: readonly TrackInfo[] = [];
  private onFailure: ChunkFailure;
  private onEnded: EpisodeEnded;
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
  private horizon: Horizon | null = null;
  private sentinel: ConstantSourceNode | null = null;
  private playbackRate = 1;
  private scheduleGeneration = 0;
  private originCtxTime = 0;
  private originTimelineSec = 0;
  private solo: Record<string, boolean> = {};
  private listenMute: Record<string, boolean> = {};

  constructor(
    ctx: AudioContext,
    fetchChunk: FetchChunk,
    onFailure: ChunkFailure,
    onEnded: EpisodeEnded,
  ) {
    this.ctx = ctx;
    this.fetchChunk = fetchChunk;
    this.onFailure = onFailure;
    this.onEnded = onEnded;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
  }

  setSnapshot(snapshot: ProxyPlaybackSnapshot): void {
    const { tracks, manifest, clipsByTrack, volumeByTrack } = snapshot;
    const scheduleKey = JSON.stringify([
      manifest.tracks,
      manifest.artifacts,
      manifest.occurrences,
      clipsByTrack,
      volumeByTrack,
    ]);
    const changed = scheduleKey !== this.scheduleKey;
    this.scheduleKey = scheduleKey;
    this.snapshot = snapshot;
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
      const now = this.currentTimeSec();
      this.scheduleGeneration += 1;
      this.horizon = null;
      this.stopSources();
      if (this.playing) this.schedule(now);
    }
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
    // Play at the end of the episode starts it over instead of sounding nothing.
    if (fromTimelineSec >= this.durationSec()) fromTimelineSec = 0;
    this.playing = true;
    this.originTimelineSec = fromTimelineSec;
    this.originCtxTime = this.ctx.currentTime;
    // iPhone mutes Web Audio on the silent switch unless the page is in a playback session.
    enterPlaybackSession();
    void this.ctx.resume();
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
    this.horizon = null;
    this.scheduleGeneration += 1;
    this.stopSources();
    this.originTimelineSec = t;
    leavePlaybackSession();
    void this.ctx.suspend();
    return t;
  }

  seek(timelineSec: number): void {
    const wasPlaying = this.playing;
    this.scheduleGeneration += 1;
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
      this.durationSec(),
      this.originTimelineSec +
        (this.ctx.currentTime - this.originCtxTime) * this.playbackRate,
    );
  }

  private get scheduleReady(): boolean {
    return this.horizon !== null;
  }

  private durationSec(): number {
    return this.snapshot?.durationSec ?? Number.POSITIVE_INFINITY;
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

  dispose(): void {
    this.pause();
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
        this.decodedBytes -= buf.length * 4;
        this.buffers.delete(evict);
      }
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
    try {
      const ab = await this.fetchChunk(ref);
      if (generation !== this.scheduleGeneration) return null;
      const buf = await this.ctx.decodeAudioData(ab.slice(0));
      if (generation !== this.scheduleGeneration) return null;
      this.buffers.set(key, buf);
      this.touchLru(key, buf.length * 4);
      return buf;
    } catch (error) {
      if (generation === this.scheduleGeneration) this.fail(error, ref);
      return null;
    }
  }

  private fail(error: unknown, ref: ImmutableChunkRef | null): void {
    this.pause();
    this.onFailure(error, ref);
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
      if (generation === this.scheduleGeneration) this.fail(error, null);
    });
  }

  private slicesBetween(
    snapshot: ProxyPlaybackSnapshot,
    startSec: number,
    endSec: number,
  ): ScheduledSlice[] {
    return Object.values(snapshot.clipsByTrack).flatMap((clips) =>
      buildSchedule(
        clips,
        startSec,
        endSec,
        snapshot.manifest,
        snapshot.volumeByTrack,
      ),
    );
  }

  /** Fills `decoded` with the buffer of every chunk the slices need, fetching what is not cached. */
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
    const generation = ++this.scheduleGeneration;
    const snapshot = this.snapshot;
    if (!snapshot || !this.playing) return;
    const windowStart = Math.max(0, timelineSec - WINDOW_PAD_SEC);
    const windowEnd = timelineSec + WINDOW_PAD_SEC;
    const slices = this.slicesBetween(snapshot, windowStart, windowEnd);
    const decoded = new Map<string, AudioBuffer>();
    await this.decodeInto(decoded, slices, generation);
    if (!this.playing || generation !== this.scheduleGeneration) return;
    this.stopSources();
    this.place(slices, decoded, this.currentTimeSec());
    this.horizon = { generation, throughSec: windowEnd };
    this.arm();
  }

  /** Starts a source for every slice at its place on the audio clock, catching up any that are already under way. */
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

  /** Schedules the next stretch of slices; runs when the sentinel finds the scheduled sound running low. */
  private async extend(horizon: Horizon): Promise<void> {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    const { generation } = horizon;
    // From the old edge, not the playhead: a late wake still gets the slices that should already be sounding.
    const from = horizon.throughSec;
    const t = this.currentTimeSec();
    const to =
      Math.max(from, t) +
      Math.max(WINDOW_PAD_SEC, 2 * LOW_WATER_CTX_SEC * this.playbackRate);
    // A slice that straddles `from` already has its source from the earlier batch;
    // one that has already ended is not worth fetching after a late wake.
    const slices = this.slicesBetween(snapshot, from, to).filter(
      (slice) =>
        slice.whenTimelineSec >= from &&
        slice.whenTimelineSec + slice.durationSec > t,
    );
    const decoded = new Map<string, AudioBuffer>();
    await this.decodeInto(decoded, slices, generation);
    if (!this.playing || generation !== this.scheduleGeneration) return;
    this.place(slices, decoded, this.currentTimeSec());
    horizon.throughSec = to;
    this.arm();
  }

  /** The timeline second at which the engine must next act: schedule more, or end the episode. */
  private wakeTimelineSec(horizon: Horizon): number {
    const duration = this.durationSec();
    return horizon.throughSec >= duration
      ? duration
      : horizon.throughSec - LOW_WATER_CTX_SEC * this.playbackRate;
  }

  /** Wakes the engine from the audio clock, which keeps running when timers and frames are throttled. */
  private arm(): void {
    this.disarm();
    const horizon = this.horizon;
    if (!horizon) return;
    const { generation } = horizon;
    const wakeTimelineSec = this.wakeTimelineSec(horizon);
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
    if (!this.playing || !horizon) return;
    this.pruneEnded();
    const t = this.currentTimeSec();
    if (t >= this.durationSec()) {
      this.finish();
      return;
    }
    if (t < this.wakeTimelineSec(horizon)) {
      this.arm();
      return;
    }
    void this.extend(horizon).catch((error: unknown) => {
      if (horizon.generation === this.scheduleGeneration)
        this.fail(error, null);
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
    this.onEnded(this.pause());
  }
}
