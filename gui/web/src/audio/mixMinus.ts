import { dbToLinear } from "../utils/audio";

export const MIX_MINUS_RAMP_S = 0.02;
export const SIDETONE_GAIN_DB = -12;
export const SIDETONE_MAX_GAIN_DB = 0;
export const SIDETONE_LABEL = "sidetone";

export const dbToGain = dbToLinear;

export type MixMinusLink = {
  from: string;
  to: "speaker" | "tap" | "destination";
  label?: string;
  gainDb?: number;
};

export type MixMinusOptions = {
  localId: string;
  sidetone?: boolean;
  sidetoneGainDb?: number;
};

type RemoteInput = {
  id: string;
  source: AudioNode;
  gain: GainNode;
  current: number;
};

function clampSidetoneDb(db: number): number {
  if (db > SIDETONE_MAX_GAIN_DB) {
    return SIDETONE_MAX_GAIN_DB;
  }
  return db;
}

function rampGain(
  param: AudioParam,
  from: number,
  to: number,
  start: number,
): void {
  param.cancelScheduledValues(start);
  param.setValueAtTime(from, start);
  param.linearRampToValueAtTime(to, start + MIX_MINUS_RAMP_S);
}

export class MixMinusGraph {
  private readonly ctx: BaseAudioContext;
  private readonly localId: string;
  private readonly sidetoneGainDb: number;
  private readonly speaker: GainNode;
  private readonly tap: GainNode;
  private sidetone: GainNode | null = null;
  private local: AudioNode | null = null;
  private readonly remotes = new Map<string, RemoteInput>();
  private readonly recorded: MixMinusLink[] = [];
  private readonly detachTimers = new Map<string, number>();

  constructor(ctx: BaseAudioContext, opts: MixMinusOptions) {
    this.ctx = ctx;
    this.localId = opts.localId;
    this.sidetoneGainDb = clampSidetoneDb(
      opts.sidetoneGainDb ?? SIDETONE_GAIN_DB,
    );
    this.speaker = ctx.createGain();
    this.speaker.gain.value = 1;
    this.tap = ctx.createGain();
    this.tap.gain.value = 1;
    this.speaker.connect(ctx.destination);
    this.recorded.push({ from: "speaker", to: "destination" });
    if (opts.sidetone) {
      this.sidetone = ctx.createGain();
      this.sidetone.gain.value = dbToGain(this.sidetoneGainDb);
      this.sidetone.connect(this.speaker);
    }
  }

  get speakerBus(): GainNode {
    return this.speaker;
  }

  get localTap(): GainNode {
    return this.tap;
  }

  connectLocal(source: AudioNode): void {
    this.disconnectLocal();
    this.local = source;
    source.connect(this.tap);
    this.recorded.push({ from: this.localId, to: "tap" });
    if (this.sidetone) {
      source.connect(this.sidetone);
      this.recorded.push({
        from: this.localId,
        to: "speaker",
        label: SIDETONE_LABEL,
        gainDb: this.sidetoneGainDb,
      });
    }
  }

  disconnectLocal(): void {
    if (!this.local) {
      return;
    }
    this.local.disconnect(this.tap);
    if (this.sidetone) {
      this.local.disconnect(this.sidetone);
    }
    this.local = null;
    this.forgetFrom(this.localId);
  }

  addRemote(id: string, source: AudioNode, atTime?: number): void {
    if (this.remotes.has(id)) {
      this.detachRemote(id);
    }
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    source.connect(gain);
    gain.connect(this.speaker);
    const start = atTime ?? this.ctx.currentTime;
    rampGain(gain.gain, 0, 1, start);
    this.remotes.set(id, { id, source, gain, current: 1 });
    this.recorded.push({ from: id, to: "speaker" });
  }

  removeRemote(id: string, atTime?: number): void {
    const remote = this.remotes.get(id);
    if (!remote) {
      return;
    }
    const start = atTime ?? this.ctx.currentTime;
    rampGain(remote.gain.gain, remote.current, 0, start);
    remote.current = 0;
    this.forgetFrom(id);
    if (atTime !== undefined) {
      return;
    }
    const previous = this.detachTimers.get(id);
    if (previous !== undefined) {
      window.clearTimeout(previous);
    }
    const holdMs = MIX_MINUS_RAMP_S * 1000 + 5;
    const timer = window.setTimeout(() => {
      this.detachTimers.delete(id);
      this.detachRemote(id);
    }, holdMs);
    this.detachTimers.set(id, timer);
  }

  setRemoteMuted(id: string, muted: boolean, atTime?: number): void {
    const remote = this.remotes.get(id);
    if (!remote) {
      return;
    }
    const target = muted ? 0 : 1;
    const start = atTime ?? this.ctx.currentTime;
    rampGain(remote.gain.gain, remote.current, target, start);
    remote.current = target;
  }

  connections(): MixMinusLink[] {
    return this.recorded.map((link) => ({ ...link }));
  }

  dispose(): void {
    for (const id of [...this.remotes.keys()]) {
      this.detachRemote(id);
    }
    this.disconnectLocal();
    this.sidetone?.disconnect();
    this.tap.disconnect();
    this.speaker.disconnect();
    this.recorded.length = 0;
  }

  private detachRemote(id: string): void {
    const timer = this.detachTimers.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      this.detachTimers.delete(id);
    }
    const remote = this.remotes.get(id);
    if (!remote) {
      return;
    }
    try {
      remote.source.disconnect(remote.gain);
    } catch {
      remote.source.disconnect();
    }
    remote.gain.disconnect();
    this.remotes.delete(id);
  }

  private forgetFrom(id: string): void {
    for (let i = this.recorded.length - 1; i >= 0; i--) {
      if (this.recorded[i]?.from === id) {
        this.recorded.splice(i, 1);
      }
    }
  }
}
