import type { ClipRow } from "../types/project";
import { dbToLinear, trackIsAudible, trackOutputGainDb } from "../utils/audio";
import {
  buildSchedule,
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

type FetchChunk = (trackId: string, idx: number) => Promise<ArrayBuffer>;

interface ActiveSource {
  source: AudioBufferSourceNode;
  gain: GainNode;
}

export class ProxyEngine {
  private ctx: AudioContext;
  private fetchChunk: FetchChunk;
  private manifest: ProxyManifest | null = null;
  private clipsByTrack: Record<string, ClipRow[]> = {};
  private clipsKey = "";
  private tracks: TrackInfo[] = [];
  private buffers = new Map<string, AudioBuffer>();
  private lru: string[] = [];
  private decodedBytes = 0;
  private trackGains = new Map<string, GainNode>();
  private master: GainNode;
  private active: ActiveSource[] = [];
  private playing = false;
  private playbackRate = 1;
  private scheduleGeneration = 0;
  private originCtxTime = 0;
  private originTimelineSec = 0;
  private solo: Record<string, boolean> = {};
  private listenMute: Record<string, boolean> = {};

  constructor(ctx: AudioContext, fetchChunk: FetchChunk) {
    this.ctx = ctx;
    this.fetchChunk = fetchChunk;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
  }

  setManifest(m: ProxyManifest): void {
    this.manifest = m;
  }

  setProject(
    clipsByTrack: Record<string, ClipRow[]>,
    tracks: TrackInfo[],
  ): void {
    // Full snapshots rebuild `clips` even when nothing moved, so compare
    // what the clips say rather than the object.
    const clipsKey = JSON.stringify(clipsByTrack);
    const clipsChanged = clipsKey !== this.clipsKey;
    this.clipsKey = clipsKey;
    this.clipsByTrack = clipsByTrack;
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
    this.applyGains();
    // A volume or mute change only moves gains; new clips need new sources.
    if (this.playing && clipsChanged) {
      const now = this.currentTimeSec();
      this.stopSources();
      void this.scheduleAround(now);
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
    void this.ctx.resume();
    void this.scheduleAround(fromTimelineSec);
  }

  setPlaybackRate(rate: number): void {
    if (rate === this.playbackRate) return;
    const at = this.currentTimeSec();
    this.originTimelineSec = at;
    this.originCtxTime = this.ctx.currentTime;
    this.playbackRate = rate;
    if (this.playing) void this.scheduleAround(at);
  }

  pause(): number {
    const t = this.currentTimeSec();
    this.playing = false;
    this.scheduleGeneration += 1;
    this.stopSources();
    this.originTimelineSec = t;
    return t;
  }

  seek(timelineSec: number): void {
    const wasPlaying = this.playing;
    this.stopSources();
    this.originTimelineSec = timelineSec;
    this.originCtxTime = this.ctx.currentTime;
    if (wasPlaying) {
      void this.scheduleAround(timelineSec);
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

  dispose(): void {
    this.pause();
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

  private bufKey(trackId: string, idx: number): string {
    return `${trackId}/${idx}`;
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
    trackId: string,
    idx: number,
  ): Promise<AudioBuffer | null> {
    const key = this.bufKey(trackId, idx);
    const existing = this.buffers.get(key);
    if (existing) {
      this.touchLru(key, 0);
      return existing;
    }
    const track = this.manifest?.tracks[trackId];
    if (!track || idx < 0 || idx >= track.chunk_count) {
      return null;
    }
    const ab = await this.fetchChunk(trackId, idx);
    const buf = await this.ctx.decodeAudioData(ab.slice(0));
    this.buffers.set(key, buf);
    this.touchLru(key, buf.length * 4);
    return buf;
  }

  private applyFades(
    gain: GainNode,
    slice: ScheduledSlice,
    when: number,
  ): void {
    const g = gain.gain;
    const start = Math.max(when, this.ctx.currentTime);
    const end = when + slice.durationSec / this.playbackRate;
    const fadeIn = slice.fadeInSec / this.playbackRate;
    const fadeOut = slice.fadeOutSec / this.playbackRate;
    const initial = Math.min(
      fadeIn > 0 ? Math.min(1, (start - when) / fadeIn) : 1,
      fadeOut > 0 ? Math.min(1, (end - start) / fadeOut) : 1,
    );
    g.cancelScheduledValues(start);
    g.setValueAtTime(Math.max(0, initial), start);
    if (fadeIn > 0 && when + fadeIn > start) {
      g.linearRampToValueAtTime(1, when + fadeIn);
    }
    if (fadeOut > 0) {
      if (end - fadeOut > start) g.setValueAtTime(1, end - fadeOut);
      g.linearRampToValueAtTime(0, end);
    }
  }

  private async scheduleAround(timelineSec: number): Promise<void> {
    const generation = ++this.scheduleGeneration;
    if (!this.manifest) {
      return;
    }
    const windowStart = Math.max(0, timelineSec - WINDOW_PAD_SEC);
    const windowEnd = timelineSec + WINDOW_PAD_SEC;
    const slices: ScheduledSlice[] = [];
    for (const [tid, clips] of Object.entries(this.clipsByTrack)) {
      const meta = this.manifest.tracks[tid];
      if (!meta) {
        continue;
      }
      slices.push(
        ...buildSchedule(
          clips,
          windowStart,
          windowEnd,
          meta.chunk_sec,
          meta.overlap_ms,
        ),
      );
    }
    const needed = new Set(
      slices.map((s) => this.bufKey(s.trackId, s.chunkIdx)),
    );
    await Promise.all(
      [...needed].map(async (key) => {
        const [tid, idxStr] = key.split("/");
        await this.ensureBuffer(tid, Number(idxStr));
      }),
    );
    if (!this.playing || generation !== this.scheduleGeneration) {
      return;
    }
    timelineSec = this.currentTimeSec();
    this.stopSources();
    const nowCtx = this.ctx.currentTime;
    for (const slice of slices) {
      const buf = this.buffers.get(this.bufKey(slice.trackId, slice.chunkIdx));
      const trackGain = this.trackGains.get(slice.trackId);
      if (!buf || !trackGain) {
        continue;
      }
      const when =
        nowCtx + (slice.whenTimelineSec - timelineSec) / this.playbackRate;
      if (when + slice.durationSec / this.playbackRate < nowCtx) {
        continue;
      }
      const source = this.ctx.createBufferSource();
      source.buffer = buf;
      source.playbackRate.value = this.playbackRate;
      const clipGain = this.ctx.createGain();
      source.connect(clipGain);
      clipGain.connect(trackGain);
      this.applyFades(clipGain, slice, when);
      const offset = slice.bufferOffsetSec;
      try {
        if (when >= nowCtx) {
          source.start(when, offset, slice.durationSec);
        } else {
          const skipped = (nowCtx - when) * this.playbackRate;
          source.start(
            nowCtx,
            offset + skipped,
            Math.max(0.01, slice.durationSec - skipped),
          );
        }
      } catch {
        continue;
      }
      this.active.push({ source, gain: clipGain });
    }
  }
}
