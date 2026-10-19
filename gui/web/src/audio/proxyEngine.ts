import type { ClipRow } from "../types/project";
import { dbToLinear, trackIsAudible, trackOutputGainDb } from "../utils/audio";
import { createChannelPeakTap } from "./channelPeakTap";
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
/** Time constant for a live gain change (reaches ~99% in 5x this). */
const GAIN_GLIDE_SEC = 0.01;
const LRU_BUDGET_BYTES = 500 * 1024 * 1024;

export interface ProxyPlaybackSnapshot {
  readonly manifest: ProxyManifest;
  readonly clipsByTrack: Readonly<Record<string, readonly ClipRow[]>>;
  readonly tracks: readonly TrackInfo[];
}

type FetchChunk = (ref: ImmutableChunkRef) => Promise<ArrayBuffer>;
type ChunkFailure = (error: unknown, ref: ImmutableChunkRef | null) => void;

interface ActiveSource {
  source: AudioBufferSourceNode;
  gain: GainNode;
}

export class ProxyEngine {
  private ctx: AudioContext;
  private fetchChunk: FetchChunk;
  private snapshot: ProxyPlaybackSnapshot | null = null;
  private scheduleKey = "";
  private tracks: readonly TrackInfo[] = [];
  private onFailure: ChunkFailure;
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
  private scheduleReady = false;
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
  ) {
    this.ctx = ctx;
    this.fetchChunk = fetchChunk;
    this.onFailure = onFailure;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
  }

  setSnapshot(snapshot: ProxyPlaybackSnapshot): void {
    const { tracks, manifest, clipsByTrack } = snapshot;
    const scheduleKey = JSON.stringify([
      manifest.tracks,
      manifest.artifacts,
      manifest.occurrences,
      clipsByTrack,
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
      this.scheduleReady = false;
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
    this.scheduleReady = false;
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
    this.scheduleReady = false;
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
    return (
      this.originTimelineSec +
      (this.ctx.currentTime - this.originCtxTime) * this.playbackRate
    );
  }

  readTrackFrame(trackId: string): ArrayLike<number> | null {
    if (
      this.ctx.state !== "running" ||
      !this.playing ||
      !this.scheduleReady ||
      !this.snapshot ||
      (!this.snapshot.manifest.tracks[trackId] &&
        !Object.values(this.snapshot.manifest.occurrences).some(
          (binding) => binding.outputTrackId === trackId,
        ))
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
    const envelope = slice.envelope;
    const timelineAt = (at: number) =>
      slice.whenTimelineSec + (at - when) * this.playbackRate;
    const valueAt = (at: number) =>
      Math.max(
        0,
        Math.min(
          1,
          envelope.fadeInSec > 0
            ? (at - envelope.timelineStartSec) / envelope.fadeInSec
            : 1,
          envelope.fadeOutSec > 0
            ? (envelope.timelineEndSec - at) / envelope.fadeOutSec
            : 1,
        ),
      );
    const points = [start, end];
    const addPoint = (timeline: number) => {
      const at = when + (timeline - slice.whenTimelineSec) / this.playbackRate;
      if (at > start && at < end) points.push(at);
    };
    addPoint(envelope.timelineStartSec + envelope.fadeInSec);
    addPoint(envelope.timelineEndSec - envelope.fadeOutSec);
    if (envelope.fadeInSec > 0 && envelope.fadeOutSec > 0)
      addPoint(
        (envelope.fadeInSec * envelope.timelineEndSec +
          envelope.fadeOutSec * envelope.timelineStartSec) /
          (envelope.fadeInSec + envelope.fadeOutSec),
      );
    points.sort((a, b) => a - b);
    gain.gain.cancelScheduledValues(start);
    gain.gain.setValueAtTime(valueAt(timelineAt(start)), start);
    for (const point of points.slice(1))
      gain.gain.linearRampToValueAtTime(valueAt(timelineAt(point)), point);
  }

  private schedule(timelineSec: number): void {
    const generation = this.scheduleGeneration + 1;
    void this.scheduleAround(timelineSec).catch((error: unknown) => {
      if (generation === this.scheduleGeneration) this.fail(error, null);
    });
  }

  private async scheduleAround(timelineSec: number): Promise<void> {
    this.scheduleReady = false;
    const generation = ++this.scheduleGeneration;
    const snapshot = this.snapshot;
    if (!snapshot || !this.playing) return;
    const windowStart = Math.max(0, timelineSec - WINDOW_PAD_SEC);
    const windowEnd = timelineSec + WINDOW_PAD_SEC;
    const slices = Object.values(snapshot.clipsByTrack).flatMap((clips) =>
      buildSchedule(clips, windowStart, windowEnd, snapshot.manifest),
    );
    const needed = new Map(
      slices.map((slice) => [chunkRefKey(slice.chunk), slice.chunk]),
    );
    await Promise.all(
      [...needed.values()].map((ref) => this.ensureBuffer(ref, generation)),
    );
    if (!this.playing || generation !== this.scheduleGeneration) return;
    timelineSec = this.currentTimeSec();
    this.stopSources();
    const nowCtx = this.ctx.currentTime;
    for (const slice of slices) {
      if (generation !== this.scheduleGeneration) return;
      const buf = this.buffers.get(chunkRefKey(slice.chunk));
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
      try {
        source.start(
          Math.max(when, nowCtx),
          slice.bufferOffsetSec + skipped,
          slice.durationSec - skipped,
        );
      } catch {
        source.disconnect();
        clipGain.disconnect();
        continue;
      }
      this.active.push({ source, gain: clipGain });
    }
    this.scheduleReady = true;
  }
}
