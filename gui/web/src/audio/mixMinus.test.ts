import { describe, expect, it } from "vitest";
import { toKeeperPcm } from "../record/keeper/pcm";
import { attachRemoteSource } from "../record/monitor/useRecordMonitor";
import {
  dbToGain,
  MIX_MINUS_RAMP_S,
  MixMinusGraph,
  SIDETONE_GAIN_DB,
  SIDETONE_LABEL,
} from "./mixMinus";

const SAMPLE_RATE = 48_000;
const TONE_DBFS = -18;
const TONE_GAIN = dbToGain(TONE_DBFS);
const FREQS = { A: 220, B: 440, C: 880, D: 1320 } as const;
const STEP_LIMIT = dbToGain(-30);

type Kind = "gain" | "osc" | "impulse" | "dest";

type Automation = { t: number; v: number; ramp: boolean };

class FakeParam {
  private current: number;
  events: Automation[];

  constructor(value: number) {
    this.current = value;
    this.events = [{ t: 0, v: value, ramp: false }];
  }

  get value(): number {
    return this.current;
  }

  set value(next: number) {
    this.current = next;
    this.events = [{ t: 0, v: next, ramp: false }];
  }

  cancelScheduledValues(t: number): void {
    this.events = this.events.filter((event) => event.t < t);
    if (this.events.length === 0) {
      this.events.push({ t: 0, v: this.value, ramp: false });
    }
  }

  setValueAtTime(v: number, t: number): void {
    this.cancelScheduledValues(t);
    this.events.push({ t, v, ramp: false });
    this.current = v;
  }

  linearRampToValueAtTime(v: number, t: number): void {
    this.events.push({ t, v, ramp: true });
    this.current = v;
  }

  at(t: number): number {
    const events = this.events;
    const first = events[0];
    if (!first) {
      return this.current;
    }
    if (t <= first.t) {
      return first.v;
    }
    for (let i = 1; i < events.length; i++) {
      const prev = events[i - 1];
      const cur = events[i];
      if (!prev || !cur) {
        continue;
      }
      if (t < cur.t) {
        if (!cur.ramp) {
          return prev.v;
        }
        const span = cur.t - prev.t;
        if (span <= 0) {
          return cur.v;
        }
        return prev.v + (cur.v - prev.v) * ((t - prev.t) / span);
      }
    }
    return events[events.length - 1]?.v ?? this.current;
  }
}

class FakeNode {
  kind: Kind;
  ins: FakeNode[] = [];
  outs: FakeNode[] = [];
  gain = new FakeParam(1);
  frequency = { value: 440 };
  started = 0;
  stopped = Number.POSITIVE_INFINITY;
  impulseAt: number | null = null;
  ctx: FakeCtx;

  constructor(kind: Kind, ctx: FakeCtx) {
    this.kind = kind;
    this.ctx = ctx;
  }

  connect(dest: FakeNode): void {
    if (!this.outs.includes(dest)) {
      this.outs.push(dest);
    }
    if (!dest.ins.includes(this)) {
      dest.ins.push(this);
    }
  }

  disconnect(dest?: FakeNode): void {
    if (dest) {
      this.outs = this.outs.filter((node) => node !== dest);
      dest.ins = dest.ins.filter((node) => node !== this);
      return;
    }
    for (const out of this.outs) {
      out.ins = out.ins.filter((node) => node !== this);
    }
    this.outs = [];
  }

  start(t = 0): void {
    this.started = t;
  }

  stop(t: number): void {
    this.stopped = t;
  }
}

class FakeCtx {
  currentTime = 0;
  sampleRate = SAMPLE_RATE;
  destination: FakeNode;

  constructor() {
    this.destination = new FakeNode("dest", this);
  }

  createGain(): FakeNode {
    return new FakeNode("gain", this);
  }

  createOscillator(): FakeNode {
    return new FakeNode("osc", this);
  }

  createImpulse(at = 0): FakeNode {
    const node = new FakeNode("impulse", this);
    node.impulseAt = at;
    return node;
  }
}

function mixAt(node: FakeNode, t: number, stack: Set<FakeNode>): number {
  if (stack.has(node)) {
    return 0;
  }
  stack.add(node);
  let raw = 0;
  if (node.kind === "osc") {
    if (t >= node.started && t < node.stopped) {
      raw = Math.sin(2 * Math.PI * node.frequency.value * t);
    }
  } else if (node.kind === "impulse") {
    const width = 0.5 / node.ctx.sampleRate;
    raw =
      node.impulseAt !== null && Math.abs(t - node.impulseAt) < width ? 1 : 0;
  } else {
    for (const input of node.ins) {
      raw += mixAt(input, t, stack);
    }
  }
  stack.delete(node);
  if (node.kind === "gain" || node.kind === "dest") {
    return raw * node.gain.at(t);
  }
  return raw;
}

function renderNode(node: FakeNode, duration: number, start = 0): Float32Array {
  const length = Math.max(1, Math.round(duration * SAMPLE_RATE));
  const out = new Float32Array(length);
  const stack = new Set<FakeNode>();
  for (let i = 0; i < length; i++) {
    out[i] = mixAt(node, start + i / SAMPLE_RATE, stack);
  }
  return out;
}

function goertzelPower(samples: Float32Array, freq: number): number {
  const w = (2 * Math.PI * freq) / SAMPLE_RATE;
  const coeff = 2 * Math.cos(w);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < samples.length; i++) {
    s0 = (samples[i] ?? 0) + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return power / (samples.length * samples.length + 1e-20);
}

function db(power: number): number {
  return 10 * Math.log10(Math.max(power, 1e-20));
}

function relDb(num: number, den: number): number {
  return db(num) - db(den);
}

function slice(
  samples: Float32Array,
  startS: number,
  endS: number,
): Float32Array {
  const a = Math.max(0, Math.round(startS * SAMPLE_RATE));
  const b = Math.min(samples.length, Math.round(endS * SAMPLE_RATE));
  return samples.subarray(a, Math.max(a + 1, b));
}

function tone(ctx: FakeCtx, freq: number): FakeNode {
  const osc = ctx.createOscillator();
  osc.frequency.value = freq;
  const level = ctx.createGain();
  level.gain.value = TONE_GAIN;
  osc.connect(level);
  osc.start(0);
  return level;
}

function asCtx(ctx: FakeCtx): BaseAudioContext {
  return ctx as unknown as BaseAudioContext;
}

function asNode(node: FakeNode): AudioNode {
  return node as unknown as AudioNode;
}

function maxStep(samples: Float32Array): number {
  let peak = 0;
  for (let i = 1; i < samples.length; i++) {
    const step = Math.abs((samples[i] ?? 0) - (samples[i - 1] ?? 0));
    if (step > peak) {
      peak = step;
    }
  }
  return peak;
}

function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] ?? 0;
    sum += s * s;
  }
  return Math.sqrt(sum / Math.max(1, samples.length));
}

type Seat = { id: string; freq: number };

function buildGraph(
  ctx: FakeCtx,
  listener: Seat,
  remotes: Seat[],
  tones: Map<string, FakeNode>,
  opts?: { sidetone?: boolean },
): MixMinusGraph {
  const graph = new MixMinusGraph(asCtx(ctx), {
    localId: listener.id,
    sidetone: opts?.sidetone,
  });
  const local = tones.get(listener.id);
  if (local) {
    graph.connectLocal(asNode(local));
  }
  for (const remote of remotes) {
    const src = tones.get(remote.id);
    if (src) {
      graph.addRemote(remote.id, asNode(src), 0);
    }
  }
  return graph;
}

function measureBus(
  speaker: Float32Array,
  taps: Record<string, Float32Array>,
  seats: Seat[],
  listenerId: string,
  window: [number, number] = [0.05, 0.9],
): Record<string, number> {
  const bus = slice(speaker, window[0], window[1]);
  const out: Record<string, number> = {};
  for (const seat of seats) {
    const tap = taps[seat.id];
    if (!tap) {
      continue;
    }
    const tapSlice = slice(tap, window[0], window[1]);
    out[seat.id] = relDb(
      goertzelPower(bus, seat.freq),
      goertzelPower(tapSlice, seat.freq),
    );
  }
  const self = seats.find((seat) => seat.id === listenerId);
  if (self) {
    out.self = out[self.id] ?? -200;
  }
  return out;
}

function assertMm1(
  rel: Record<string, number>,
  remotes: Seat[],
  listenerId: string,
): void {
  expect(rel.self, `${listenerId} self leak`).toBeLessThanOrEqual(-50);
  for (const remote of remotes) {
    if (remote.id === listenerId) {
      continue;
    }
    expect(
      Math.abs(rel[remote.id] ?? 99),
      `${listenerId} vs ${remote.id}`,
    ).toBeLessThanOrEqual(1.5);
  }
}

describe("MixMinusGraph MM1–MM9", () => {
  it("MM1: listener A hears B and C, not self", () => {
    const ctx = new FakeCtx();
    const seats: Seat[] = [
      { id: "A", freq: FREQS.A },
      { id: "B", freq: FREQS.B },
      { id: "C", freq: FREQS.C },
    ];
    const tones = new Map(seats.map((seat) => [seat.id, tone(ctx, seat.freq)]));
    const graph = buildGraph(ctx, seats[0]!, seats.slice(1), tones);
    const speaker = renderNode(graph.speakerBus as unknown as FakeNode, 1);
    const taps = {
      A: renderNode(graph.localTap as unknown as FakeNode, 1),
      B: renderNode(tones.get("B") as FakeNode, 1),
      C: renderNode(tones.get("C") as FakeNode, 1),
    };
    assertMm1(measureBus(speaker, taps, seats, "A"), seats.slice(1), "A");
  });

  it("MM2: permutes for B and C and N=2/3/4", () => {
    const sizes: Seat[][] = [
      [
        { id: "A", freq: FREQS.A },
        { id: "B", freq: FREQS.B },
      ],
      [
        { id: "A", freq: FREQS.A },
        { id: "B", freq: FREQS.B },
        { id: "C", freq: FREQS.C },
      ],
      [
        { id: "A", freq: FREQS.A },
        { id: "B", freq: FREQS.B },
        { id: "C", freq: FREQS.C },
        { id: "D", freq: FREQS.D },
      ],
    ];
    for (const seats of sizes) {
      const ctx = new FakeCtx();
      const tones = new Map(
        seats.map((seat) => [seat.id, tone(ctx, seat.freq)]),
      );
      for (const listener of seats) {
        const remotes = seats.filter((seat) => seat.id !== listener.id);
        const graph = buildGraph(ctx, listener, remotes, tones);
        const speaker = renderNode(graph.speakerBus as unknown as FakeNode, 1);
        const taps: Record<string, Float32Array> = {
          [listener.id]: renderNode(graph.localTap as unknown as FakeNode, 1),
        };
        for (const remote of remotes) {
          taps[remote.id] = renderNode(tones.get(remote.id) as FakeNode, 1);
        }
        assertMm1(
          measureBus(speaker, taps, seats, listener.id),
          remotes,
          listener.id,
        );
        graph.dispose();
      }
    }
  });

  it("MM3: local is not wired to destination; remotes are; sidetone is labeled", () => {
    const ctx = new FakeCtx();
    const a = tone(ctx, FREQS.A);
    const b = tone(ctx, FREQS.B);
    const graph = new MixMinusGraph(asCtx(ctx), {
      localId: "A",
      sidetone: true,
    });
    graph.connectLocal(asNode(a));
    graph.addRemote("B", asNode(b), 0);
    const links = graph.connections();
    expect(
      links.some((link) => link.from === "A" && link.to === "destination"),
    ).toBe(false);
    expect(links.some((link) => link.from === "A" && link.to === "tap")).toBe(
      true,
    );
    expect(
      links.some((link) => link.from === "B" && link.to === "speaker"),
    ).toBe(true);
    expect(
      links.some(
        (link) => link.from === "speaker" && link.to === "destination",
      ),
    ).toBe(true);
    const sidetone = links.find((link) => link.label === SIDETONE_LABEL);
    expect(sidetone).toMatchObject({
      from: "A",
      to: "speaker",
      gainDb: SIDETONE_GAIN_DB,
    });
    const dest = ctx.destination as FakeNode;
    expect(dest.ins.includes(a)).toBe(false);
    expect(dest.ins.includes(graph.speakerBus as unknown as FakeNode)).toBe(
      true,
    );
  });

  it("MM4: mute B drops 440 on A", () => {
    const ctx = new FakeCtx();
    const seats: Seat[] = [
      { id: "A", freq: FREQS.A },
      { id: "B", freq: FREQS.B },
      { id: "C", freq: FREQS.C },
    ];
    const tones = new Map(seats.map((seat) => [seat.id, tone(ctx, seat.freq)]));
    const graphA = buildGraph(ctx, seats[0]!, seats.slice(1), tones);
    graphA.setRemoteMuted("B", true, 0.5);
    const speaker = renderNode(graphA.speakerBus as unknown as FakeNode, 1.2);
    const tapC = renderNode(tones.get("C") as FakeNode, 1.2);
    const before = slice(speaker, 0.05, 0.45);
    const after = slice(speaker, 0.55, 0.95);
    const drop = relDb(
      goertzelPower(after, FREQS.B),
      goertzelPower(before, FREQS.B),
    );
    expect(drop).toBeLessThanOrEqual(-40);
    const cBefore = relDb(
      goertzelPower(before, FREQS.C),
      goertzelPower(slice(tapC, 0.05, 0.45), FREQS.C),
    );
    const cAfter = relDb(
      goertzelPower(after, FREQS.C),
      goertzelPower(slice(tapC, 0.55, 0.95), FREQS.C),
    );
    expect(Math.abs(cAfter - cBefore)).toBeLessThanOrEqual(1.5);
  });

  it("applies roster mute when attaching a remote that was muted first", () => {
    const ctx = new FakeCtx();
    const graph = new MixMinusGraph(asCtx(ctx), { localId: "A" });
    const source = asNode(tone(ctx, FREQS.B));
    const sources = new Map<string, AudioNode>();
    graph.setRemoteMuted("B", true, 0);
    attachRemoteSource(graph, sources, "B", source, true);
    const speaker = renderNode(graph.speakerBus as unknown as FakeNode, 0.4);
    expect(
      db(goertzelPower(slice(speaker, 0.05, 0.35), FREQS.B)),
    ).toBeLessThanOrEqual(-40);
  });

  it("MM5: A's keeper matches the dry tap and excludes remotes", () => {
    const ctx = new FakeCtx();
    const seats: Seat[] = [
      { id: "A", freq: FREQS.A },
      { id: "B", freq: FREQS.B },
      { id: "C", freq: FREQS.C },
    ];
    const tones = new Map(seats.map((seat) => [seat.id, tone(ctx, seat.freq)]));
    const graph = buildGraph(ctx, seats[0]!, seats.slice(1), tones);
    const tap = renderNode(graph.localTap as unknown as FakeNode, 1);
    const wav = toKeeperPcm(tap, SAMPLE_RATE, false);
    const wavF = new Float32Array(wav.length);
    for (let i = 0; i < wav.length; i++) {
      wavF[i] = (wav[i] ?? 0) / 32768;
    }
    const win = slice(tap, 0.05, 0.9);
    const wavWin = slice(wavF, 0.05, 0.9);
    expect(
      Math.abs(
        relDb(goertzelPower(wavWin, FREQS.A), goertzelPower(win, FREQS.A)),
      ),
    ).toBeLessThanOrEqual(3);
    expect(db(goertzelPower(wavWin, FREQS.B))).toBeLessThanOrEqual(-50);
    expect(db(goertzelPower(wavWin, FREQS.C))).toBeLessThanOrEqual(-50);
    const speaker = renderNode(graph.speakerBus as unknown as FakeNode, 1);
    expect(
      relDb(
        goertzelPower(slice(speaker, 0.05, 0.9), FREQS.A),
        goertzelPower(win, FREQS.A),
      ),
    ).toBeLessThanOrEqual(-50);
  });

  it("MM6: local impulse does not grow on the speaker bus", () => {
    const ctx = new FakeCtx();
    const graph = new MixMinusGraph(asCtx(ctx), { localId: "A" });
    graph.connectLocal(asNode(ctx.createImpulse(0)));
    const speaker = renderNode(graph.speakerBus as unknown as FakeNode, 1);
    const first = rms(slice(speaker, 0, 0.1));
    const last = rms(slice(speaker, 0.9, 1));
    expect(first).toBeLessThan(1e-6);
    expect(last).toBeLessThanOrEqual(first + 1e-9);
  });

  it("disconnects only graph-owned local links before a microphone retry", () => {
    const ctx = new FakeCtx();
    const graph = new MixMinusGraph(asCtx(ctx), {
      localId: "A",
      sidetone: true,
    });
    const first = ctx.createGain();
    const next = ctx.createGain();
    graph.connectLocal(asNode(first));
    expect(first.outs).toHaveLength(2);
    graph.disconnectLocal();
    expect(first.outs).toHaveLength(0);
    graph.disconnectLocal();
    graph.connectLocal(asNode(next));
    expect(next.outs).toHaveLength(2);
    graph.dispose();
    expect(next.outs).toHaveLength(0);
  });

  it("MM7: attaching a silent encoder tap does not duck the monitor", () => {
    const ctx = new FakeCtx();
    const seats: Seat[] = [
      { id: "A", freq: FREQS.A },
      { id: "B", freq: FREQS.B },
      { id: "C", freq: FREQS.C },
    ];
    const tones = new Map(seats.map((seat) => [seat.id, tone(ctx, seat.freq)]));
    const graph = buildGraph(ctx, seats[0]!, seats.slice(1), tones);
    const preroll = renderNode(graph.speakerBus as unknown as FakeNode, 1);
    const silent = ctx.createGain();
    silent.gain.value = 0;
    tones.get("A")?.connect(silent);
    silent.connect(ctx.destination);
    const live = renderNode(graph.speakerBus as unknown as FakeNode, 1);
    const taps = {
      A: renderNode(graph.localTap as unknown as FakeNode, 1),
      B: renderNode(tones.get("B") as FakeNode, 1),
      C: renderNode(tones.get("C") as FakeNode, 1),
    };
    assertMm1(measureBus(preroll, taps, seats, "A"), seats.slice(1), "A");
    assertMm1(measureBus(live, taps, seats, "A"), seats.slice(1), "A");
    for (const freq of [FREQS.B, FREQS.C]) {
      expect(
        Math.abs(
          relDb(
            goertzelPower(slice(live, 0.05, 0.9), freq),
            goertzelPower(slice(preroll, 0.05, 0.9), freq),
          ),
        ),
      ).toBeLessThanOrEqual(0.5);
    }
  });

  it("MM8: roster ramps within 20 ms and does not touch A's keeper", () => {
    const ctx = new FakeCtx();
    const a = tone(ctx, FREQS.A);
    const b = tone(ctx, FREQS.B);
    const c = tone(ctx, FREQS.C);
    const graph = new MixMinusGraph(asCtx(ctx), { localId: "A" });
    graph.connectLocal(asNode(a));
    graph.addRemote("B", asNode(b), 0);
    graph.addRemote("C", asNode(c), 1);
    graph.removeRemote("B", 2);
    const speaker = renderNode(graph.speakerBus as unknown as FakeNode, 5);
    const tapA = renderNode(graph.localTap as unknown as FakeNode, 5);
    const tapB = renderNode(b, 5);
    const tapC = renderNode(c, 5);
    const afterAdd = slice(speaker, 1 + MIX_MINUS_RAMP_S, 1.2);
    expect(
      Math.abs(
        relDb(
          goertzelPower(afterAdd, FREQS.C),
          goertzelPower(slice(tapC, 1.05, 1.2), FREQS.C),
        ),
      ),
    ).toBeLessThanOrEqual(1.5);
    const afterRemove = slice(speaker, 2 + MIX_MINUS_RAMP_S, 2.2);
    const beforeRemove = slice(speaker, 1.5, 1.9);
    expect(
      relDb(
        goertzelPower(afterRemove, FREQS.B),
        goertzelPower(beforeRemove, FREQS.B),
      ),
    ).toBeLessThanOrEqual(-40);
    const self = slice(speaker, 0.05, 4.9);
    expect(
      relDb(
        goertzelPower(self, FREQS.A),
        goertzelPower(slice(tapA, 0.05, 4.9), FREQS.A),
      ),
    ).toBeLessThanOrEqual(-50);
    expect(maxStep(slice(speaker, 0.98, 1.04))).toBeLessThanOrEqual(STEP_LIMIT);
    expect(maxStep(slice(speaker, 1.98, 2.04))).toBeLessThanOrEqual(STEP_LIMIT);
    const baseline = new MixMinusGraph(asCtx(ctx), { localId: "A" });
    baseline.connectLocal(asNode(a));
    baseline.addRemote("B", asNode(b), 0);
    const keeperChanged = toKeeperPcm(tapA, SAMPLE_RATE, false);
    const keeperStable = toKeeperPcm(
      renderNode(baseline.localTap as unknown as FakeNode, 5),
      SAMPLE_RATE,
      false,
    );
    expect(keeperChanged).toEqual(keeperStable);
    const paused = measureBus(
      speaker,
      { A: tapA, B: tapB, C: tapC },
      [
        { id: "A", freq: FREQS.A },
        { id: "C", freq: FREQS.C },
      ],
      "A",
      [3.05, 4.9],
    );
    expect(paused.self).toBeLessThanOrEqual(-50);
    expect(Math.abs(paused.C ?? 99)).toBeLessThanOrEqual(1.5);
  });

  it("MM9: producer hears everyone, never captures, and does not enter the mix", () => {
    const ctx = new FakeCtx();
    const seats: Seat[] = [
      { id: "A", freq: FREQS.A },
      { id: "B", freq: FREQS.B },
      { id: "C", freq: FREQS.C },
    ];
    const tones = new Map(seats.map((seat) => [seat.id, tone(ctx, seat.freq)]));
    const graphP = new MixMinusGraph(asCtx(ctx), { localId: "P" });
    for (const seat of seats) {
      graphP.addRemote(seat.id, asNode(tones.get(seat.id) as FakeNode), 0);
    }
    expect(graphP.connections().some((link) => link.from === "P")).toBe(false);
    const speakerP = renderNode(graphP.speakerBus as unknown as FakeNode, 1);
    for (const seat of seats) {
      const tap = renderNode(tones.get(seat.id) as FakeNode, 1);
      expect(
        Math.abs(
          relDb(
            goertzelPower(slice(speakerP, 0.05, 0.9), seat.freq),
            goertzelPower(slice(tap, 0.05, 0.9), seat.freq),
          ),
        ),
      ).toBeLessThanOrEqual(1.5);
    }
    const graphA = buildGraph(ctx, seats[0]!, seats.slice(1), tones);
    const speakerA = renderNode(graphA.speakerBus as unknown as FakeNode, 1);
    const taps = {
      A: renderNode(graphA.localTap as unknown as FakeNode, 1),
      B: renderNode(tones.get("B") as FakeNode, 1),
      C: renderNode(tones.get("C") as FakeNode, 1),
    };
    assertMm1(measureBus(speakerA, taps, seats, "A"), seats.slice(1), "A");
    expect(toKeeperPcm(new Float32Array(0), SAMPLE_RATE, false)).toEqual(
      new Int16Array(0),
    );
  });
});
