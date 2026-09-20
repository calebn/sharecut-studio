import type { ClipRow } from "../types/project";
import { dbToLinear } from "../utils/audio";
import {
  buildSchedule,
  type ProxyManifest,
  type ScheduledSlice,
} from "./proxyMath";

export interface TrackInfo {
  id: string;
  gain_db: number;
  muted: boolean;
}

const WINDOW_PAD_SEC = 120;
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
  private tracks: TrackInfo[] = [];
  private buffers = new Map<string, AudioBuffer>();
  private lru: string[] = [];
  private decodedBytes = 0;
  private trackGains = new Map<string, GainNode>();
  private master: GainNode;
  private active: ActiveSource[] = [];
  private playing = false;
  private originCtxTime = 0;
  private originTimelineSec = 0;
  private solo: Set<string> = new Set();

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
    this.clipsByTrack = clipsByTrack;
    this.tracks = tracks;
    for (const t of tracks) {
      if (!this.trackGains.has(t.id)) {
        const g = this.ctx.createGain();
        g.connect(this.master);
        this.trackGains.set(t.id, g);
      }
      this.setTrackState(t.id, t.gain_db, t.muted);
    }
    if (this.playing) {
      const now = this.currentTimeSec();
      this.stopSources();
      void this.scheduleAround(now);
    }
  }

  setSolo(soloTracks: Record<string, boolean>): void {
    this.solo = new Set(
      Object.entries(soloTracks)
        .filter(([, on]) => on)
        .map(([id]) => id),
    );
    for (const t of this.tracks) {
      this.setTrackState(t.id, t.gain_db, t.muted);
    }
  }

  setTrackState(trackId: string, gainDb: number, muted: boolean): void {
    const g = this.trackGains.get(trackId);
    if (!g) {
      return;
    }
    const soloActive = this.solo.size > 0;
    const audible = !muted && (!soloActive || this.solo.has(trackId));
    g.gain.value = audible ? dbToLinear(gainDb) : 0;
  }

  play(fromTimelineSec: number): void {
    this.playing = true;
    this.originTimelineSec = fromTimelineSec;
    this.originCtxTime = this.ctx.currentTime;
    void this.ctx.resume();
    void this.scheduleAround(fromTimelineSec);
  }

  pause(): number {
    const t = this.currentTimeSec();
    this.playing = false;
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
    return this.originTimelineSec + (this.ctx.currentTime - this.originCtxTime);
  }

  dispose(): void {
    this.pause();
    this.buffers.clear();
    this.lru = [];
    this.decodedBytes = 0;
  }

  copyCachedPcmWindow(
    trackId: string,
    startSec: number,
    endSec: number,
  ): { pcm: Float32Array; sampleRate: number } | null {
    const meta = this.manifest?.tracks[trackId];
    if (!meta || !(endSec > startSec)) {
      return null;
    }
    const chunkSec = meta.chunk_sec;
    if (!(chunkSec > 0)) {
      return null;
    }
    const i0 = Math.floor(startSec / chunkSec);
    const i1 = Math.floor((endSec - 1e-9) / chunkSec);
    const bufs: Array<{ buf: AudioBuffer; idx: number }> = [];
    for (let i = i0; i <= i1; i++) {
      const buf = this.buffers.get(this.bufKey(trackId, i));
      if (!buf) {
        return null;
      }
      bufs.push({ buf, idx: i });
    }
    if (bufs.length === 0) {
      return null;
    }
    const sampleRate = bufs[0]?.buf.sampleRate ?? 0;
    if (!(sampleRate > 0)) {
      return null;
    }
    const n = Math.max(1, Math.ceil((endSec - startSec) * sampleRate));
    const out = new Float32Array(n);
    for (const { buf, idx } of bufs) {
      const chunkStart = idx * chunkSec;
      const ch0 = buf.getChannelData(0);
      const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
      const localStart = Math.max(0, startSec - chunkStart);
      const localEnd = Math.min(chunkSec, endSec - chunkStart);
      const f0 = Math.floor(localStart * sampleRate);
      const f1 = Math.min(ch0.length, Math.ceil(localEnd * sampleRate));
      const destOff = Math.floor(
        (chunkStart + localStart - startSec) * sampleRate,
      );
      for (let f = f0; f < f1; f++) {
        const a = ch0[f] ?? 0;
        const b = ch1 ? (ch1[f] ?? 0) : 0;
        const peak = Math.max(Math.abs(a), Math.abs(b));
        const di = destOff + (f - f0);
        if (di >= 0 && di < out.length && peak > (out[di] ?? 0)) {
          out[di] = peak;
        }
      }
    }
    return { pcm: out, sampleRate };
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
    g.cancelScheduledValues(when);
    if (slice.fadeInSec > 0) {
      g.setValueAtTime(0, when);
      if (slice.gainCurve === "equalPower") {
        g.linearRampToValueAtTime(1, when + slice.fadeInSec);
      } else {
        g.linearRampToValueAtTime(1, when + slice.fadeInSec);
      }
    } else {
      g.setValueAtTime(1, when);
    }
    if (slice.fadeOutSec > 0) {
      const fadeStart = when + slice.durationSec - slice.fadeOutSec;
      g.setValueAtTime(1, Math.max(when, fadeStart));
      g.linearRampToValueAtTime(0, when + slice.durationSec);
    }
  }

  private async scheduleAround(timelineSec: number): Promise<void> {
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
    if (!this.playing) {
      return;
    }
    this.stopSources();
    const nowCtx = this.ctx.currentTime;
    for (const slice of slices) {
      const buf = this.buffers.get(this.bufKey(slice.trackId, slice.chunkIdx));
      const trackGain = this.trackGains.get(slice.trackId);
      if (!buf || !trackGain) {
        continue;
      }
      const when = nowCtx + (slice.whenTimelineSec - timelineSec);
      if (when + slice.durationSec < nowCtx) {
        continue;
      }
      const source = this.ctx.createBufferSource();
      source.buffer = buf;
      const clipGain = this.ctx.createGain();
      source.connect(clipGain);
      clipGain.connect(trackGain);
      this.applyFades(clipGain, slice, Math.max(when, nowCtx));
      const offset = slice.bufferOffsetSec;
      const startAt = Math.max(0, when - nowCtx);
      try {
        if (when >= nowCtx) {
          source.start(when, offset, slice.durationSec);
        } else {
          const skipped = nowCtx - when;
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
      void startAt;
    }
  }
}
