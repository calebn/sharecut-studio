import { Blob as NodeBlob } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiSend } from "../api/http";
import { createChannelPeakTap } from "./channelPeakTap";
import {
  createHostPlaybackMeterMonitor,
  type HostMeterTrack,
} from "./hostPlaybackMeterMonitor";

vi.mock("../api/http", () => ({ apiSend: vi.fn(), HOST_KEY: "" }));

vi.mock("./channelPeakTap", () => ({
  createChannelPeakTap: vi.fn(
    (
      _context: unknown,
      node: { gain: { value: number }; media?: FakeAudio; slots?: number[] },
    ) => ({
      read: () => {
        const data = node.media && localBytes.get(node.media.src);
        if (!data || !node.media)
          return new Float32Array([
            0.5 * node.gain.value,
            -0.25 * node.gain.value,
          ]);
        const view = new DataView(data);
        const rate = view.getUint32(24, true);
        const channels = view.getUint16(22, true);
        const frame = Math.floor(node.media.currentTime * rate);
        return new Float32Array(
          [0, 1].map((channel) => {
            const slot = node.slots?.[channel] ?? (node.slots ? -1 : channel);
            return slot < 0 || slot >= channels
              ? 0
              : (view.getInt16(44 + (frame * channels + slot) * 2, true) /
                  32768) *
                  node.gain.value;
          }),
        );
      },
      dispose: vi.fn(),
    }),
  ),
}));

const defaultTap = vi.mocked(createChannelPeakTap).getMockImplementation()!;
const localBytes = new Map<string, ArrayBuffer>();
const blobReads = new Set<Promise<void>>();

function fakeAudioParam(value: number) {
  let stored = Math.fround(value);
  return Object.defineProperty({}, "value", {
    enumerable: true,
    get: () => stored,
    set: (next: number) => {
      stored = Math.fround(next);
    },
  }) as { value: number };
}

class FakeAudio extends EventTarget {
  static created: FakeAudio[] = [];
  currentTime = 0;
  readyState = 0;
  seeking = false;
  paused = true;
  ended = false;
  playbackRate = 1;
  volume = 1;
  src = "";
  crossOrigin = "";
  preload = "";
  play = vi.fn(async () => {
    this.paused = false;
  });
  pause = vi.fn(() => {
    this.paused = true;
  });
  removeAttribute = vi.fn(() => {
    this.src = "";
  });
  load = vi.fn();
  constructor() {
    super();
    FakeAudio.created.push(this);
  }
}

class FakeContext extends EventTarget {
  static created: FakeContext[] = [];
  static failGain = false;
  state = "running";
  currentTime = 0;
  sampleRate = 48000;
  close = vi.fn(async () => {});
  resume = vi.fn(async () => {});
  suspend = vi.fn(async () => {});
  sourceVolumes: number[] = [];
  source = { connect: vi.fn(), disconnect: vi.fn() };
  gain = { gain: fakeAudioParam(1), disconnect: vi.fn() };
  createMediaElementSource = vi.fn((media: FakeAudio) => {
    this.sourceVolumes.push(media.volume);
    if (!media.src.startsWith("blob:") && !wavFixture) return this.source;
    return {
      connect: (gain: { media?: FakeAudio }) => {
        gain.media = media;
      },
      disconnect: vi.fn(),
    };
  });
  createChannelSplitter = vi.fn((_count: number) => {
    const node: {
      media?: FakeAudio;
      connect: (
        target: { media?: FakeAudio; slots: number[] },
        output: number,
        input: number,
      ) => void;
      disconnect: ReturnType<typeof vi.fn>;
    } = {
      connect: (target, output, input) => {
        target.media = node.media;
        target.slots[input] = output;
      },
      disconnect: vi.fn(),
    };
    return node;
  });
  createChannelMerger = vi.fn((_count: number) => {
    const node: {
      media?: FakeAudio;
      slots: number[];
      connect: (target: { media?: FakeAudio; slots?: number[] }) => void;
      disconnect: ReturnType<typeof vi.fn>;
    } = {
      slots: [],
      connect: (target) => {
        target.media = node.media;
        target.slots = [...node.slots];
      },
      disconnect: vi.fn(),
    };
    return node;
  });
  createGain = vi.fn(() => {
    if (FakeContext.failGain) throw new Error("graph unavailable");
    return wavFixture
      ? { gain: fakeAudioParam(1), disconnect: vi.fn() }
      : this.gain;
  });
  constructor() {
    super();
    FakeContext.created.push(this);
  }
}

function nativeProgress(media: FakeAudio) {
  media.dispatchEvent(new Event("playing"));
  media.currentTime += 0.01;
  media.dispatchEvent(new Event("timeupdate"));
}

type NativeTrack = HostMeterTrack & { delivery: "native" };
function native(track: Omit<NativeTrack, "delivery">): NativeTrack {
  return { ...track, delivery: "native" };
}
function setup() {
  let playing = true;
  let rate = 1;
  let tracks: HostMeterTrack[] = [
    native({ id: "host", url: "/stem/host", gain: 2, mediaSec: 12 }),
  ];
  const monitor = createHostPlaybackMeterMonitor({
    tracks: () => tracks,
    clock: () => (playing ? { playbackRate: rate } : null),
  });
  return {
    monitor,
    setPlaying: (value: boolean) => {
      playing = value;
    },
    setRate: (value: number) => {
      rate = value;
    },
    setTracks: (value: HostMeterTrack[]) => {
      tracks = value;
    },
  };
}

beforeEach(() => {
  FakeAudio.created = [];
  FakeContext.created = [];
  FakeContext.failGain = false;
  wavFixture = false;
  localBytes.clear();
  blobReads.clear();
  vi.mocked(apiSend).mockReset();
  vi.mocked(createChannelPeakTap).mockReset().mockImplementation(defaultTap);
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("AudioContext", FakeContext);
});
afterEach(() => vi.unstubAllGlobals());

describe("host playback meter monitor", () => {
  it("waits for an in-flight seek before correcting to the latest position", async () => {
    const { monitor, setTracks } = setup();
    expect(monitor.read("host")).toBeNull();
    const media = FakeAudio.created[0];
    media.readyState = 2;
    monitor.sync();
    nativeProgress(media);
    await Promise.resolve();
    await Promise.resolve();
    let position = 0;
    const writes: number[] = [];
    Object.defineProperty(media, "currentTime", {
      get: () => position,
      set: (value: number) => {
        writes.push(value);
        position = value;
        media.seeking = true;
      },
    });
    media.readyState = 2;
    monitor.sync();
    expect(writes).toEqual([12]);
    expect(monitor.read("host")).toBeNull();
    expect(media.paused).toBe(false);

    for (const mediaSec of [12.2, 12.4, 12.6]) {
      setTracks([native({ id: "host", url: "/stem/host", gain: 2, mediaSec })]);
      monitor.sync();
      expect(monitor.read("host")).toBeNull();
    }
    expect(writes).toEqual([12]);

    media.seeking = false;
    media.dispatchEvent(new Event("seeked"));
    monitor.sync();
    expect(writes).toEqual([12, 12.6]);
    expect(monitor.read("host")).toBeNull();
    media.seeking = false;
    media.dispatchEvent(new Event("seeked"));
    monitor.sync();
    expect(monitor.read("host")).toBeNull();
    position += 0.01;
    media.dispatchEvent(new Event("timeupdate"));
    monitor.sync();
    expect(monitor.read("host")).toBeNull();
    FakeContext.created[0].currentTime += 2048 / 48000;
    monitor.sync();
    expect(monitor.read("host")).toEqual(new Float32Array([1, -0.5]));
    monitor.dispose();
  });

  it("withholds a raw sample when the primary crosses the freshness boundary after frame sync", async () => {
    const { monitor, setTracks } = setup();
    monitor.read("host");
    const media = FakeAudio.created[0];
    media.readyState = 2;
    monitor.sync();
    let position = media.currentTime;
    vi.mocked(createChannelPeakTap).mockReturnValueOnce({
      read: () => new Float32Array(position > 12.08 ? [0.5, -0.25] : [1, -0.5]),
      dispose: vi.fn(),
    });
    nativeProgress(media);
    await Promise.resolve();
    await Promise.resolve();
    position = media.currentTime;
    const stalledAt = position;
    const writes: number[] = [];
    Object.defineProperty(media, "currentTime", {
      get: () => position,
      set: (next: number) => {
        writes.push(next);
        position = next;
        media.seeking = true;
        media.dispatchEvent(new Event("seeking"));
      },
    });
    const target = (mediaSec: number) =>
      setTracks([native({ id: "host", url: "/stem/host", gain: 2, mediaSec })]);
    expect(monitor.read("host")).toEqual(new Float32Array([1, -0.5]));
    for (let frame = 1; frame <= 4; frame++) {
      target(stalledAt + frame * 0.016);
      FakeContext.created[0].currentTime += 0.016;
      monitor.sync();
      expect(monitor.read("host")).not.toBeNull();
    }

    monitor.sync();
    target(stalledAt + 0.09);
    expect.soft(writes).toEqual([]);
    expect.soft(monitor.read("host")).toBeNull();

    FakeContext.created[0].currentTime += 0.016;
    monitor.sync();
    expect(writes).toEqual([stalledAt + 0.09]);
    expect(media.seeking).toBe(true);
    expect(monitor.read("host")).toBeNull();
    target(stalledAt + 0.106);
    monitor.sync();
    expect(writes).toHaveLength(1);
    expect(monitor.read("host")).toBeNull();
    media.seeking = false;
    media.dispatchEvent(new Event("seeked"));
    position += 0.016;
    media.dispatchEvent(new Event("timeupdate"));
    monitor.sync();
    expect(monitor.read("host")).toBeNull();
    FakeContext.created[0].currentTime += 2049 / 48000;
    monitor.sync();
    expect(monitor.read("host")).toEqual(new Float32Array([0.5, -0.25]));
    monitor.dispose();
  });

  it("holds a raw pre-seek clip until the full post-progress tap history is warm", async () => {
    const { monitor, setTracks } = setup();
    monitor.read("host");
    const media = FakeAudio.created[0];
    const context = FakeContext.created[0];
    let historyReplacedAt = Infinity;
    vi.mocked(createChannelPeakTap).mockReturnValueOnce({
      read: () =>
        new Float32Array(
          context.currentTime < historyReplacedAt ? [1, -0.5] : [0.25, -0.125],
        ),
      dispose: vi.fn(),
    });
    media.readyState = 2;
    monitor.sync();
    nativeProgress(media);
    await Promise.resolve();
    await Promise.resolve();
    expect(monitor.read("host")).toEqual(new Float32Array([1, -0.5]));
    let observed = media.currentTime;
    const writes: number[] = [];
    Object.defineProperty(media, "currentTime", {
      get: () => observed,
      set: (next: number) => {
        writes.push(next);
        media.seeking = true;
        media.dispatchEvent(new Event("seeking"));
      },
    });
    const target = (mediaSec: number) =>
      setTracks([native({ id: "host", url: "/stem/host", gain: 2, mediaSec })]);
    target(24);
    monitor.sync();
    expect(writes).toEqual([24]);
    expect(monitor.read("host")).toBeNull();
    context.currentTime += 0.016;
    monitor.sync();
    expect(writes).toHaveLength(1);
    observed = 24;
    media.seeking = false;
    media.dispatchEvent(new Event("seeked"));
    monitor.sync();
    expect.soft(monitor.read("host")).toBeNull();

    observed += 0.016;
    target(observed);
    media.dispatchEvent(new Event("timeupdate"));
    historyReplacedAt = context.currentTime + 2048 / context.sampleRate;
    monitor.sync();
    expect.soft(monitor.read("host")).toBeNull();
    context.currentTime += 2047 / context.sampleRate;
    monitor.sync();
    expect.soft(monitor.read("host")).toBeNull();
    context.currentTime += 2 / context.sampleRate;
    monitor.sync();
    expect(monitor.read("host")).toEqual(new Float32Array([0.25, -0.125]));
    monitor.dispose();
  });

  it.each(["gain", "rate"])(
    "warms raw tap history after a bound %s change",
    async (change) => {
      const { monitor, setTracks, setRate } = setup();
      monitor.read("host");
      const media = FakeAudio.created[0];
      const context = FakeContext.created[0];
      let historyReplacedAt = Infinity;
      vi.mocked(createChannelPeakTap).mockReturnValueOnce({
        read: () =>
          new Float32Array(
            context.currentTime < historyReplacedAt
              ? [1, -0.5]
              : [0.25, -0.125],
          ),
        dispose: vi.fn(),
      });
      media.readyState = 2;
      monitor.sync();
      nativeProgress(media);
      await Promise.resolve();
      await Promise.resolve();
      expect(monitor.read("host")).toEqual(new Float32Array([1, -0.5]));
      if (change === "gain")
        setTracks([
          native({ id: "host", url: "/stem/host", gain: 0.5, mediaSec: 12 }),
        ]);
      else setRate(1.5);
      historyReplacedAt = context.currentTime + 2048 / context.sampleRate;
      monitor.sync();
      expect.soft(monitor.read("host")).toBeNull();
      context.currentTime += 2047 / context.sampleRate;
      monitor.sync();
      expect.soft(monitor.read("host")).toBeNull();
      context.currentTime += 2 / context.sampleRate;
      monitor.sync();
      expect(monitor.read("host")).toEqual(new Float32Array([0.25, -0.125]));
      monitor.dispose();
    },
  );

  it("creates no media or context when stopped", () => {
    const { monitor, setPlaying } = setup();
    setPlaying(false);
    expect(monitor.read("host")).toBeNull();
    expect(FakeAudio.created).toHaveLength(0);
    expect(FakeContext.created).toHaveLength(0);
    monitor.dispose();
  });

  it("reports loading as unavailable then samples at output gain and the real media clock", async () => {
    const { monitor, setRate, setTracks } = setup();
    expect(monitor.read("host")).toBeNull();
    const media = FakeAudio.created[0];
    expect(media.src).toBe("/stem/host");
    media.readyState = 2;
    monitor.sync();
    nativeProgress(media);
    await Promise.resolve();
    await Promise.resolve();
    expect(monitor.read("host")).toEqual(new Float32Array([1, -0.5]));
    expect(media.currentTime).toBe(12.01);
    expect(FakeContext.created[0].gain.gain.value).toBe(2);
    setRate(1.5);
    setTracks([
      native({ id: "host", url: "/stem/host", gain: 0.5, mediaSec: 24 }),
    ]);
    monitor.sync();
    expect(monitor.read("host")).toBeNull();
    expect(media.currentTime).toBe(24);
    expect(media.playbackRate).toBe(1.5);
    media.currentTime += 0.01;
    media.dispatchEvent(new Event("timeupdate"));
    monitor.sync();
    expect(monitor.read("host")).toBeNull();
    FakeContext.created[0].currentTime += 2048 / 48000;
    monitor.sync();
    expect(monitor.read("host")).toEqual(new Float32Array([0.25, -0.125]));
    expect(FakeAudio.created).toHaveLength(1);
    await Promise.resolve();
    monitor.dispose();
  });

  it("pauses immediately on stop and never returns old samples", () => {
    const { monitor, setPlaying } = setup();
    monitor.read("host");
    const media = FakeAudio.created[0];
    media.readyState = 2;
    monitor.sync();
    nativeProgress(media);
    monitor.read("host");
    setPlaying(false);
    monitor.sync();
    expect(media.paused).toBe(true);
    expect(monitor.read("host")).toBeNull();
    monitor.dispose();
  });

  it("releases meter media while the private clock is unavailable and recovers", async () => {
    const { monitor, setPlaying, setRate, setTracks } = setup();
    expect(monitor.read("host")).toBeNull();
    const media = FakeAudio.created[0];
    media.readyState = 2;
    monitor.sync();
    nativeProgress(media);
    expect(media.src).toBe("/stem/host");
    expect(monitor.read("host")).toEqual(new Float32Array([1, -0.5]));

    setPlaying(false);
    monitor.sync();
    expect(media.paused).toBe(true);
    expect(media.src).toBe("");
    const loadCount = media.load.mock.calls.length;
    expect(monitor.read("host")).toBeNull();
    expect(FakeAudio.created).toHaveLength(1);
    expect(media.load).toHaveBeenCalledTimes(loadCount);

    await Promise.resolve();
    await Promise.resolve();
    setRate(1.5);
    setTracks([
      native({ id: "host", url: "/stem/host", gain: 0.5, mediaSec: 24 }),
    ]);
    setPlaying(true);
    expect(monitor.read("host")).toBeNull();
    const resumedMedia = FakeAudio.created.at(-1);
    expect(resumedMedia?.src).toBe("/stem/host");
    resumedMedia!.readyState = 2;
    monitor.sync();
    nativeProgress(resumedMedia!);
    expect(resumedMedia!.currentTime).toBe(24.01);
    expect(resumedMedia!.playbackRate).toBe(1.5);
    expect(FakeContext.created.at(-1)!.gain.gain.value).toBe(0.5);
    expect(monitor.read("host")).toEqual(new Float32Array([0.25, -0.125]));
    monitor.dispose();
  });

  it("returns verified zero for mute and source-clock gaps without loading audio", () => {
    const { monitor, setTracks } = setup();
    setTracks([native({ id: "host", url: "/raw/host", gain: 0, mediaSec: 5 })]);
    monitor.sync();
    expect(monitor.read("host")).toEqual(new Float32Array(2));
    setTracks([
      native({ id: "host", url: "/raw/host", gain: 1, mediaSec: null }),
    ]);
    monitor.sync();
    expect(monitor.read("host")).toEqual(new Float32Array(2));
    expect(FakeAudio.created).toHaveLength(0);
    expect(monitor.read("missing")).toBeNull();
    monitor.dispose();
  });

  it("reports seeking and failed media as unavailable", () => {
    const { monitor } = setup();
    monitor.read("host");
    const media = FakeAudio.created[0];
    media.readyState = 2;
    monitor.sync();
    nativeProgress(media);
    media.seeking = true;
    expect(monitor.read("host")).toBeNull();
    media.seeking = false;
    media.dispatchEvent(new Event("error"));
    expect(monitor.read("host")).toBeNull();
    monitor.dispose();
  });

  it("contains graph and autoplay errors without changing audible playback", async () => {
    const { monitor } = setup();
    monitor.read("host");
    const media = FakeAudio.created[0];
    media.readyState = 2;
    media.play.mockRejectedValueOnce(
      new DOMException("blocked", "NotAllowedError"),
    );
    monitor.sync();
    expect(monitor.read("host")).toBeNull();
    await Promise.resolve();
    await Promise.resolve();
    expect(monitor.read("host")).toBeNull();
    monitor.dispose();
  });

  it("retries a play interrupted by pause when playback restarts", async () => {
    const { monitor, setPlaying } = setup();
    monitor.read("host");
    const retiredMedia = FakeAudio.created[0];
    retiredMedia.readyState = 2;
    let rejectPlay: (error: Error) => void = () => {};
    retiredMedia.play.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPlay = reject;
        }),
    );
    monitor.sync();
    setPlaying(false);
    monitor.sync();
    rejectPlay(new DOMException("play interrupted", "AbortError"));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    setPlaying(true);
    expect(monitor.read("host")).toBeNull();
    const resumedMedia = FakeAudio.created.at(-1)!;
    resumedMedia.readyState = 2;
    monitor.sync();
    nativeProgress(resumedMedia);
    expect(retiredMedia.src).toBe("");
    expect(resumedMedia.play).toHaveBeenCalledOnce();
    expect(monitor.read("host")).toEqual(new Float32Array([1, -0.5]));
    monitor.dispose();
  });

  it("ignores late play and error events from a retired reader", async () => {
    const { monitor, setPlaying } = setup();
    monitor.read("host");
    const retiredMedia = FakeAudio.created[0];
    retiredMedia.readyState = 2;
    let resolvePlay: () => void = () => {};
    retiredMedia.play.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolvePlay = () => {
            retiredMedia.paused = false;
            resolve();
          };
        }),
    );
    monitor.sync();

    setPlaying(false);
    monitor.sync();
    await Promise.resolve();
    await Promise.resolve();
    setPlaying(true);
    monitor.sync();
    monitor.read("host");
    const currentMedia = FakeAudio.created.at(-1)!;
    currentMedia.readyState = 2;
    monitor.sync();
    nativeProgress(currentMedia);

    resolvePlay();
    await Promise.resolve();
    await Promise.resolve();
    retiredMedia.dispatchEvent(new Event("error"));
    expect(retiredMedia.paused).toBe(true);
    expect(monitor.read("host")).toEqual(new Float32Array([1, -0.5]));
    expect(currentMedia.paused).toBe(false);
    monitor.dispose();
  });

  it("keeps context generations serial until close completes", async () => {
    const { monitor, setPlaying } = setup();
    expect(monitor.read("host")).toBeNull();
    const old = FakeContext.created[0];
    const media = FakeAudio.created[0];
    media.readyState = 2;
    monitor.sync();
    nativeProgress(media);
    expect(monitor.read("host")).toEqual(new Float32Array([1, -0.5]));
    let finishClose!: () => void;
    old.close.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishClose = () => {
            old.state = "closed";
            old.dispatchEvent(new Event("statechange"));
            resolve();
          };
        }),
    );
    setPlaying(false);
    monitor.sync();
    expect(media.src).toBe("");
    expect(media.paused).toBe(true);
    expect(old.close).toHaveBeenCalledOnce();
    setPlaying(true);
    for (let frame = 0; frame < 3; frame++) {
      old.currentTime += 0.016;
      monitor.sync();
      expect(monitor.read("host")).toBeNull();
      expect(FakeContext.created).toHaveLength(1);
      expect(FakeAudio.created).toHaveLength(1);
    }
    finishClose();
    await Promise.resolve();
    await Promise.resolve();
    monitor.sync();
    expect(monitor.read("host")).toBeNull();
    expect(FakeContext.created).toHaveLength(2);
    const current = FakeAudio.created.at(-1)!;
    current.readyState = 2;
    monitor.sync();
    nativeProgress(current);
    expect(monitor.read("host")).toEqual(new Float32Array([1, -0.5]));
    expect(old.close).toHaveBeenCalledOnce();
    monitor.dispose();
    expect(FakeContext.created[1].close).toHaveBeenCalledOnce();
  });

  it("does not let a retired context resume rejection poison current samples", async () => {
    const { monitor, setPlaying } = setup();
    monitor.read("host");
    const old = FakeContext.created[0];
    let rejectResume!: (reason: Error) => void;
    old.state = "suspended";
    old.resume.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectResume = reject;
        }),
    );
    old.dispatchEvent(new Event("statechange"));
    monitor.sync();
    setPlaying(false);
    monitor.sync();
    await Promise.resolve();
    await Promise.resolve();
    setPlaying(true);
    monitor.sync();
    monitor.read("host");
    const current = FakeAudio.created.at(-1)!;
    current.readyState = 2;
    monitor.sync();
    nativeProgress(current);
    expect(monitor.read("host")).toEqual(new Float32Array([1, -0.5]));
    old.state = "suspended";
    old.dispatchEvent(new Event("statechange"));
    rejectResume(new Error("retired context"));
    await Promise.resolve();
    await Promise.resolve();
    expect(monitor.read("host")).toEqual(new Float32Array([1, -0.5]));
    monitor.dispose();
  });

  it.each(["reject", "dispose"])(
    "does not replace an unresolved context after %s",
    async (action) => {
      const { monitor, setPlaying } = setup();
      monitor.read("host");
      const old = FakeContext.created[0];
      let resolveClose!: () => void;
      let rejectClose!: (reason: Error) => void;
      old.close.mockImplementationOnce(
        () =>
          new Promise<void>((resolve, reject) => {
            resolveClose = resolve;
            rejectClose = reject;
          }),
      );
      setPlaying(false);
      monitor.sync();
      expect(old.close).toHaveBeenCalledOnce();
      setPlaying(true);
      if (action === "dispose") {
        monitor.dispose();
        resolveClose();
      } else rejectClose(new Error("close not established"));
      await Promise.resolve();
      await Promise.resolve();
      monitor.sync();
      expect(monitor.read("host")).toBeNull();
      expect(FakeContext.created).toHaveLength(1);
      expect(old.close).toHaveBeenCalledOnce();
      monitor.dispose();
    },
  );

  it("releases partial graphs when audio node construction fails", () => {
    const { monitor } = setup();
    FakeContext.failGain = true;
    expect(monitor.read("host")).toBeNull();
    const media = FakeAudio.created[0];
    media.readyState = 2;
    monitor.sync();
    nativeProgress(media);
    expect(FakeAudio.created[0].src).toBe("");
    expect(FakeAudio.created[0].load).toHaveBeenCalledOnce();
    expect(FakeContext.created[0].source.disconnect).toHaveBeenCalledOnce();
    monitor.dispose();
    expect(FakeContext.created[0].close).toHaveBeenCalledOnce();
  });

  it("releases removed and replaced tracks and closes the owned context", () => {
    const { monitor, setTracks } = setup();
    monitor.read("host");
    const original = FakeAudio.created[0];
    original.readyState = 2;
    monitor.sync();
    nativeProgress(original);
    setTracks([
      native({ id: "host", url: "/raw/host", gain: 1, mediaSec: 40 }),
    ]);
    monitor.sync();
    monitor.read("host");
    expect(original.src).toBe("");
    expect(original.pause).toHaveBeenCalled();
    expect(FakeAudio.created).toHaveLength(2);
    const replacement = FakeAudio.created[1];
    replacement.readyState = 2;
    monitor.sync();
    nativeProgress(replacement);
    setTracks([]);
    monitor.sync();
    expect(FakeAudio.created[1].src).toBe("");
    const context = FakeContext.created[0];
    monitor.dispose();
    expect(context.close).toHaveBeenCalledOnce();
    expect(context.source.disconnect).toHaveBeenCalledTimes(2);
    expect(monitor.read("host")).toBeNull();
  });
});

describe("native playback progress before graph binding", () => {
  it("keeps a playing anchor through the initial seek and waits for progress after seeked", () => {
    const { monitor } = setup();
    monitor.read("host");
    const media = FakeAudio.created[0];
    const context = FakeContext.created[0];
    let position = 0;
    const writes: number[] = [];
    Object.defineProperty(media, "currentTime", {
      get: () => position,
      set: (value: number) => {
        writes.push(value);
        position = value;
        media.seeking = true;
        media.dispatchEvent(new Event("seeking"));
      },
    });
    media.readyState = 2;
    monitor.sync();
    expect(writes).toEqual([12]);
    expect(media.paused).toBe(false);
    media.dispatchEvent(new Event("playing"));
    position = 12.01;
    media.dispatchEvent(new Event("timeupdate"));
    expect(context.createMediaElementSource).not.toHaveBeenCalled();
    media.seeking = false;
    media.dispatchEvent(new Event("timeupdate"));
    expect(context.createMediaElementSource).not.toHaveBeenCalled();
    media.dispatchEvent(new Event("seeked"));
    media.dispatchEvent(new Event("timeupdate"));
    expect(context.createMediaElementSource).not.toHaveBeenCalled();
    expect(monitor.read("host")).toBeNull();
    position = 12.02;
    media.dispatchEvent(new Event("timeupdate"));
    expect(context.createMediaElementSource.mock.calls).toEqual([[media]]);
    expect(media.volume).toBe(1);
    expect(writes).toEqual([12]);
    monitor.dispose();
  });

  it.each(["equal", "backward", "paused", "seeking", "ended"] as const)(
    "does not bind on %s timeupdate and recovers on actual playback progress",
    (event) => {
      const { monitor } = setup();
      monitor.read("host");
      const media = FakeAudio.created[0];
      const context = FakeContext.created[0];
      media.readyState = 2;
      monitor.sync();
      media.dispatchEvent(new Event("playing"));
      media.currentTime =
        event === "backward" ? 11.99 : event === "equal" ? 12 : 12.01;
      media.paused = event === "paused";
      media.seeking = event === "seeking";
      media.ended = event === "ended";
      if (event === "paused") media.dispatchEvent(new Event("pause"));
      if (event === "seeking") media.dispatchEvent(new Event("seeking"));
      if (event === "ended") media.dispatchEvent(new Event("ended"));
      media.dispatchEvent(new Event("timeupdate"));
      expect(context.createMediaElementSource).not.toHaveBeenCalled();
      expect(media.volume).toBe(0);
      expect(monitor.read("host")).toBeNull();
      media.paused = false;
      media.seeking = false;
      media.ended = false;
      if (event === "seeking") media.dispatchEvent(new Event("seeked"));
      if (event === "paused" || event === "ended")
        media.dispatchEvent(new Event("playing"));
      media.currentTime = 12.02;
      media.dispatchEvent(new Event("timeupdate"));
      expect(context.createMediaElementSource.mock.calls).toEqual([[media]]);
      expect(media.volume).toBe(1);
      monitor.dispose();
    },
  );

  it("uses fresh gain and rate while keeping volume zero until the tap returns", () => {
    const { monitor, setTracks, setRate } = setup();
    monitor.read("host");
    const media = FakeAudio.created[0];
    const context = FakeContext.created[0];
    media.readyState = 2;
    monitor.sync();
    media.dispatchEvent(new Event("playing"));
    setTracks([
      native({
        id: "host",
        url: "/stem/host",
        gain: 0.5623413251903491,
        mediaSec: 12,
      }),
    ]);
    setRate(1.5);
    const tap = vi.mocked(createChannelPeakTap).getMockImplementation()!;
    vi.mocked(createChannelPeakTap).mockImplementationOnce((ctx, gain) => {
      expect(media.volume).toBe(0);
      expect(context.source.connect.mock.calls).toEqual([[context.gain]]);
      expect(context.gain.gain.value).toBe(0.5623413324356079);
      return tap(ctx, gain);
    });
    media.currentTime += 0.01;
    media.dispatchEvent(new Event("timeupdate"));
    expect(media.playbackRate).toBe(1.5);
    expect(media.volume).toBe(1);
    expect(createChannelPeakTap).toHaveBeenCalledOnce();
    monitor.dispose();
  });

  it.each(["source", "gain", "source-connect", "tap", "cleanup"] as const)(
    "rolls back a failed %s binding without unmuting or retrying",
    (failure) => {
      const { monitor } = setup();
      monitor.read("host");
      const media = FakeAudio.created[0];
      const context = FakeContext.created[0];
      const fail = () => {
        throw new Error("graph unavailable");
      };
      if (failure === "source")
        context.createMediaElementSource.mockImplementationOnce(fail);
      if (failure === "gain") context.createGain.mockImplementationOnce(fail);
      if (failure === "source-connect")
        context.source.connect.mockImplementationOnce(fail);
      if (failure === "tap" || failure === "cleanup")
        vi.mocked(createChannelPeakTap).mockImplementationOnce(fail);
      if (failure === "cleanup")
        context.gain.disconnect.mockImplementationOnce(fail);
      media.readyState = 2;
      monitor.sync();
      nativeProgress(media);
      expect(media.volume).toBe(0);
      expect(media.paused).toBe(true);
      expect(media.src).toBe("");
      expect(media.load).toHaveBeenCalledOnce();
      if (failure !== "source")
        expect(context.source.disconnect).toHaveBeenCalledOnce();
      if (failure !== "source" && failure !== "gain")
        expect(context.gain.disconnect).toHaveBeenCalledOnce();
      for (let i = 0; i < 3; i++) {
        monitor.sync();
        nativeProgress(media);
        expect(monitor.read("host")).toBeNull();
      }
      expect(context.createMediaElementSource).toHaveBeenCalledOnce();
      expect(FakeAudio.created).toHaveLength(1);
      monitor.dispose();
      expect(media.load).toHaveBeenCalledOnce();
    },
  );

  it.each(["sink", "splitter", "analyser", "input"] as const)(
    "cleans up when the real channel tap's %s connection fails",
    async (failure) => {
      const actual =
        await vi.importActual<typeof import("./channelPeakTap")>(
          "./channelPeakTap",
        );
      vi.mocked(createChannelPeakTap).mockImplementationOnce(
        actual.createChannelPeakTap,
      );
      const { monitor } = setup();
      monitor.read("host");
      const media = FakeAudio.created[0];
      const context = FakeContext.created[0];
      const fail = () => {
        throw new Error("connection failed");
      };
      const splitter = { connect: vi.fn(), disconnect: vi.fn() };
      const sink = {
        gain: fakeAudioParam(1),
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      const analysers: {
        fftSize: number;
        connect: ReturnType<typeof vi.fn>;
        disconnect: ReturnType<typeof vi.fn>;
      }[] = [];
      const inputConnect = vi.fn();
      Object.assign(context.gain, { connect: inputConnect });
      Object.assign(context, {
        destination: {},
        createChannelSplitter: () => splitter,
        createAnalyser: () => {
          const analyser = {
            fftSize: 0,
            connect: vi.fn(),
            disconnect: vi.fn(),
          };
          if (failure === "analyser")
            analyser.connect.mockImplementationOnce(fail);
          analysers.push(analyser);
          return analyser;
        },
      });
      context.createGain
        .mockReturnValueOnce(context.gain)
        .mockReturnValueOnce(sink);
      if (failure === "sink") sink.connect.mockImplementationOnce(fail);
      if (failure === "splitter") splitter.connect.mockImplementationOnce(fail);
      if (failure === "input") inputConnect.mockImplementationOnce(fail);
      media.readyState = 2;
      monitor.sync();
      nativeProgress(media);
      expect(media.volume).toBe(0);
      expect(media.src).toBe("");
      expect(media.paused).toBe(true);
      expect(context.source.disconnect).toHaveBeenCalledOnce();
      expect(context.gain.disconnect).toHaveBeenCalledOnce();
      expect(splitter.disconnect).toHaveBeenCalledOnce();
      expect(sink.disconnect).toHaveBeenCalledOnce();
      for (const analyser of analysers)
        expect(analyser.disconnect).toHaveBeenCalledOnce();
      nativeProgress(media);
      monitor.sync();
      expect(monitor.read("host")).toBeNull();
      expect(context.createMediaElementSource).toHaveBeenCalledOnce();
      monitor.dispose();
    },
  );

  it("releases a published reader when assigning its source throws", () => {
    vi.stubGlobal(
      "Audio",
      class extends FakeAudio {
        constructor() {
          super();
          Object.defineProperty(this, "src", {
            get: () => "",
            set: () => {
              throw new Error("source setup failed");
            },
          });
        }
      },
    );
    const { monitor } = setup();
    expect(monitor.read("host")).toBeNull();
    const media = FakeAudio.created[0];
    expect(media.volume).toBe(0);
    expect(media.paused).toBe(true);
    expect(media.load).toHaveBeenCalledOnce();
    media.readyState = 2;
    monitor.sync();
    nativeProgress(media);
    expect(
      FakeContext.created[0].createMediaElementSource,
    ).not.toHaveBeenCalled();
    expect(monitor.read("host")).toBeNull();
    monitor.dispose();
    expect(media.load).toHaveBeenCalledOnce();
  });

  it("releases media and listeners when reader setup throws", () => {
    let signal: AbortSignal | null | undefined;
    vi.spyOn(FakeAudio.prototype, "addEventListener").mockImplementationOnce(
      function (this: FakeAudio, type, callback, options) {
        signal = typeof options === "object" ? options.signal : undefined;
        EventTarget.prototype.addEventListener.call(
          this,
          type,
          callback,
          options,
        );
        throw new Error("listener setup failed");
      },
    );
    const { monitor } = setup();
    expect(monitor.read("host")).toBeNull();
    const media = FakeAudio.created[0];
    expect(signal?.aborted).toBe(true);
    expect(media.volume).toBe(0);
    expect(media.src).toBe("");
    expect(media.paused).toBe(true);
    expect(media.load).toHaveBeenCalledOnce();
    expect(
      FakeContext.created[0].createMediaElementSource,
    ).not.toHaveBeenCalled();
    monitor.dispose();
  });

  it.each(["clock", "mute", "url", "dispose"] as const)(
    "silences a late play settlement after %s without waiting for sync",
    async (change) => {
      const { monitor, setTracks, setPlaying } = setup();
      monitor.read("host");
      const media = FakeAudio.created[0];
      let finish: () => void = () => {};
      media.play.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = () => {
              media.paused = false;
              resolve();
            };
          }),
      );
      media.readyState = 2;
      monitor.sync();
      if (change === "clock") setPlaying(false);
      else if (change === "dispose") monitor.dispose();
      else
        setTracks([
          native({
            id: "host",
            url: change === "url" ? "/raw/new" : "/stem/host",
            gain: change === "mute" ? 0 : 2,
            mediaSec: 12,
          }),
        ]);
      finish();
      await Promise.resolve();
      await Promise.resolve();
      expect(media.volume).toBe(0);
      expect(media.paused).toBe(true);
      nativeProgress(media);
      expect(
        FakeContext.created[0].createMediaElementSource,
      ).not.toHaveBeenCalled();
      monitor.sync();
      if (change === "mute")
        expect(monitor.read("host")).toEqual(new Float32Array(2));
      else expect(monitor.read("host")).toBeNull();
      monitor.dispose();
    },
  );

  it("keeps the reader silent and unavailable until playing is followed by advancing timeupdate", async () => {
    const { monitor } = setup();
    expect(monitor.read("host")).toBeNull();
    const media = FakeAudio.created[0];
    const context = FakeContext.created[0];
    expect.soft(media.volume).toBe(0);
    expect.soft(context.createMediaElementSource).not.toHaveBeenCalled();
    media.readyState = 2;
    media.dispatchEvent(new Event("canplay"));
    monitor.sync();
    await Promise.resolve();
    await Promise.resolve();
    expect.soft(media.paused).toBe(false);
    expect.soft(monitor.read("host")).toBeNull();
    expect.soft(context.createMediaElementSource).not.toHaveBeenCalled();
    expect.soft(media.volume).toBe(0);

    media.currentTime += 0.02;
    media.dispatchEvent(new Event("timeupdate"));
    expect.soft(context.createMediaElementSource).not.toHaveBeenCalled();
    media.dispatchEvent(new Event("playing"));
    media.dispatchEvent(new Event("timeupdate"));
    expect.soft(context.createMediaElementSource).not.toHaveBeenCalled();
    expect.soft(monitor.read("host")).toBeNull();
    media.currentTime += 0.02;
    media.dispatchEvent(new Event("timeupdate"));
    expect(context.createMediaElementSource.mock.calls).toEqual([[media]]);
    expect.soft(context.sourceVolumes).toEqual([0]);
    expect(context.source.connect.mock.calls).toEqual([[context.gain]]);
    expect(context.gain.gain.value).toBe(2);
    expect(media.volume).toBe(1);
    media.currentTime += 0.01;
    media.dispatchEvent(new Event("timeupdate"));
    expect(context.createMediaElementSource).toHaveBeenCalledOnce();
    monitor.dispose();
  });

  it("aligns once during priming without chasing the moving primary clock", async () => {
    const { monitor, setTracks, setRate } = setup();
    monitor.read("host");
    const media = FakeAudio.created[0];
    media.readyState = 2;
    monitor.sync();
    await Promise.resolve();
    await Promise.resolve();
    expect(media.currentTime).toBe(12);
    media.dispatchEvent(new Event("playing"));
    for (const mediaSec of [12.2, 12.4, 12.6]) {
      setTracks([
        native({ id: "host", url: "/stem/host", gain: 0.75, mediaSec }),
      ]);
      monitor.sync();
    }
    expect.soft(media.currentTime).toBe(12);
    expect.soft(monitor.read("host")).toBeNull();
    setRate(1.5);
    media.currentTime += 0.02;
    media.dispatchEvent(new Event("timeupdate"));
    const context = FakeContext.created[0];
    expect(context.createMediaElementSource.mock.calls).toEqual([[media]]);
    expect.soft(context.sourceVolumes).toEqual([0]);
    expect(context.gain.gain.value).toBe(0.75);
    expect(media.playbackRate).toBe(1.5);
    expect(media.volume).toBe(1);
    monitor.dispose();
  });

  it.each(["clock", "mute", "gap", "url", "remove", "dispose"] as const)(
    "ignores native progress after %s changes before the next sync",
    async (change) => {
      const { monitor, setPlaying, setTracks } = setup();
      monitor.read("host");
      const media = FakeAudio.created[0];
      const context = FakeContext.created[0];
      media.readyState = 2;
      monitor.sync();
      await Promise.resolve();
      await Promise.resolve();
      media.dispatchEvent(new Event("playing"));
      if (change === "clock") setPlaying(false);
      else if (change === "dispose") monitor.dispose();
      else if (change === "remove") setTracks([]);
      else
        setTracks([
          native({
            id: "host",
            url: change === "url" ? "/raw/replacement" : "/stem/host",
            gain: change === "mute" ? 0 : 2,
            mediaSec: change === "gap" ? null : 12,
          }),
        ]);
      media.currentTime += 0.02;
      media.dispatchEvent(new Event("timeupdate"));
      media.dispatchEvent(new Event("playing"));
      media.currentTime += 0.02;
      media.dispatchEvent(new Event("timeupdate"));
      expect.soft(context.createMediaElementSource).not.toHaveBeenCalled();
      expect.soft(media.volume).toBe(0);
      monitor.sync();
      if (change === "mute" || change === "gap")
        expect(monitor.read("host")).toEqual(new Float32Array(2));
      else expect(monitor.read("host")).toBeNull();
      monitor.dispose();
    },
  );
});

let wavFixture = false;
type WavTrack = HostMeterTrack & { delivery: "wav"; readUrl: string };
type RangeCall = {
  url: string;
  start: number;
  end: number;
  signal: AbortSignal;
  validator: string | null;
};

function wavBytes(voice = 0, metadataSize = 3) {
  const rate = 8000;
  const dataOffset = 44 + 8 + metadataSize + (metadataSize % 2);
  const bytes = new Uint8Array(dataOffset + 120 * rate * 4);
  const view = new DataView(bytes.buffer);
  const tag = (offset: number, value: string) =>
    bytes.set(new TextEncoder().encode(value), offset);
  tag(0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  tag(8, "WAVE");
  tag(12, "JUNK");
  view.setUint32(16, metadataSize, true);
  const fmt = 20 + metadataSize + (metadataSize % 2);
  tag(fmt, "fmt ");
  view.setUint32(fmt + 4, 16, true);
  view.setUint16(fmt + 8, 1, true);
  view.setUint16(fmt + 10, 2, true);
  view.setUint32(fmt + 12, rate, true);
  view.setUint32(fmt + 16, rate * 4, true);
  view.setUint16(fmt + 20, 4, true);
  view.setUint16(fmt + 22, 16, true);
  tag(dataOffset - 8, "data");
  view.setUint32(dataOffset - 4, bytes.length - dataOffset, true);
  for (let frame = 0; frame < 120 * rate; frame++) {
    const sample = 512 * (voice + 1) * (1 + (Math.floor(frame / rate) % 4));
    view.setInt16(dataOffset + frame * 4, sample, true);
    view.setInt16(dataOffset + frame * 4 + 2, -sample / 2, true);
  }
  return bytes;
}

function literalPcm(rate: number, frames: number, values: number[]) {
  const bytes = new Uint8Array(44 + frames * values.length * 2);
  const view = new DataView(bytes.buffer);
  for (const [offset, word] of [
    [0, "RIFF"],
    [8, "WAVE"],
    [12, "fmt "],
    [36, "data"],
  ] as const)
    bytes.set(new TextEncoder().encode(word), offset);
  view.setUint32(4, bytes.length - 8, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, values.length, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * values.length * 2, true);
  view.setUint16(32, values.length * 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, bytes.length - 44, true);
  for (let frame = 0; frame < frames; frame++)
    for (let channel = 0; channel < values.length; channel++)
      view.setInt16(
        44 + (frame * values.length + channel) * 2,
        values[channel],
        true,
      );
  return bytes;
}

function setupWav(count = 1, bytes = wavBytes()) {
  wavFixture = true;
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL(_blob: Blob): string {
        return "";
      }
      static revokeObjectURL(_url: string): void {}
    },
  );
  let blobId = 0;
  const blobs = new Map<string, Blob>();
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    const url = `blob:meter-${++blobId}`;
    if (!(blob instanceof Blob)) throw new Error("Expected local WAV Blob");
    blobs.set(url, blob);
    const pending = blob.arrayBuffer().then((data) => {
      localBytes.set(url, data);
    });
    blobReads.add(pending);
    return url;
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation((url) => {
    blobs.delete(url);
    localBytes.delete(url);
  });
  const calls: RangeCall[] = [];
  const assets = Array.from({ length: count }, (_, index) =>
    index ? wavBytes(index) : bytes,
  );
  const response = (call: RangeCall) => {
    const voice = Number(/voice(\d+)/.exec(call.url)?.[1] ?? 0);
    const asset = assets[voice];
    return new Response(asset.slice(call.start, call.end + 1), {
      status: 206,
      headers: {
        "Content-Range": `bytes ${call.start}-${call.end}/${asset.length}`,
        "Content-Length": String(call.end - call.start + 1),
        ETag: '"asset-1"',
      },
    });
  };
  let respond: (call: RangeCall) => Response | Promise<Response> = response;
  vi.mocked(apiSend).mockImplementation(async (_key, route, init) => {
    if (!("url" in route)) throw new Error("Expected server-issued URL");
    const headers = new Headers(init?.headers);
    const match = /^bytes=(\d+)-(\d+)$/.exec(headers.get("Range") ?? "");
    if (!match) throw new Error("Expected a closed range");
    const call = {
      url: route.url,
      start: Number(match[1]),
      end: Number(match[2]),
      signal: init!.signal as AbortSignal,
      validator: headers.get("If-Range"),
    };
    calls.push(call);
    return respond(call);
  });
  let playing = true;
  let rate = 1;
  let tracks: WavTrack[] = Array.from({ length: count }, (_, voice) => ({
    id: `voice${voice}`,
    url: `/stem/voice${voice}?rerender=true&hash=a`,
    readUrl: `/stem/voice${voice}?hash=a`,
    delivery: "wav",
    gain: 1,
    mediaSec: 12.25,
  }));
  const monitor = createHostPlaybackMeterMonitor({
    tracks: () => tracks,
    clock: () => (playing ? { playbackRate: rate } : null),
  });
  const ready = async (ids = tracks.map((track) => track.id)) => {
    await vi.waitFor(async () => {
      for (const track of tracks) monitor.read(track.id);
      await Promise.all(blobReads);
      for (const media of FakeAudio.created)
        if (localBytes.has(media.src)) media.readyState = 2;
      expect(
        FakeAudio.created.filter((media) => localBytes.has(media.src)).length,
      ).toBeGreaterThan(0);
      const step = 0.08 / (4 * Math.max(1, rate));
      const duration = Math.max(
        0.1,
        ...[...localBytes.values()].map((data) => {
          const view = new DataView(data);
          return (
            (data.byteLength - 44) /
            view.getUint32(24, true) /
            (view.getUint16(22, true) * 2) /
            rate
          );
        }),
      );
      for (let tick = 0; tick < Math.ceil(duration / step) + 2; tick++) {
        await Promise.all(blobReads);
        for (const media of FakeAudio.created)
          if (localBytes.has(media.src)) media.readyState = 2;
        tracks = tracks.map((track) => ({
          ...track,
          mediaSec:
            track.mediaSec === null ? null : track.mediaSec + step * rate,
        }));
        for (const context of FakeContext.created) context.currentTime += step;
        monitor.sync();
        await Promise.resolve();
        await Promise.resolve();
        for (const media of FakeAudio.created) {
          const data = localBytes.get(media.src);
          if (!data || media.paused || media.ended) continue;
          const view = new DataView(data);
          const duration =
            (data.byteLength - 44) /
            view.getUint32(24, true) /
            (view.getUint16(22, true) * 2);
          media.dispatchEvent(new Event("playing"));
          media.currentTime = Math.min(
            duration - 1 / view.getUint32(24, true),
            media.currentTime + step * media.playbackRate,
          );
          media.dispatchEvent(new Event("timeupdate"));
          if (media.currentTime + 1 / view.getUint32(24, true) >= duration) {
            media.ended = true;
            media.paused = true;
            media.dispatchEvent(new Event("ended"));
          }
        }
        monitor.sync();
        if (ids.map((id) => monitor.read(id)).every((value) => value !== null))
          break;
      }
      for (const id of ids) expect(monitor.read(id)).not.toBeNull();
    });
    await Promise.all(blobReads);
  };
  const move = (sec: number | null, gain = 1) => {
    tracks = tracks.map((track) => ({ ...track, mediaSec: sec, gain }));
    monitor.sync();
  };
  return {
    monitor,
    ready,
    move,
    calls,
    blobs,
    response,
    assets,
    setResponder: (value: typeof respond) => {
      respond = value;
    },
    setPlaying: (value: boolean, synchronize = true) => {
      playing = value;
      if (synchronize) monitor.sync();
    },
    setRate: (value: number) => {
      rate = value;
      monitor.sync();
    },
    setTracks: (value: WavTrack[], synchronize = true) => {
      tracks = value;
      if (synchronize) monitor.sync();
    },
    advance: (seconds = 0.1) => {
      const steps = Math.ceil(seconds / (0.08 / (4 * Math.max(1, rate))));
      const step = seconds / steps;
      for (let tick = 0; tick < steps; tick++) {
        if (playing)
          tracks = tracks.map((track) => ({
            ...track,
            mediaSec:
              track.mediaSec === null ? null : track.mediaSec + step * rate,
          }));
        for (const context of FakeContext.created) context.currentTime += step;
        for (const media of FakeAudio.created)
          if (media.src && !media.paused && !media.ended)
            media.currentTime += step * media.playbackRate;
        monitor.sync();
      }
    },
    getTracks: () => tracks,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("local WAV playback progress before graph binding", () => {
  it("prepares forward native output before the first window reaches its midpoint", async () => {
    const fixture = setupWav();
    fixture.monitor.read("voice0");
    await vi.waitFor(() => expect(fixture.blobs.size).toBe(2));
    const frames = fixture.calls.filter((call) => call.end - call.start > 1024);
    expect(frames).toHaveLength(2);
    expect(frames[1].start).toBeGreaterThan(frames[0].start);
    fixture.monitor.dispose();
  });

  it("primes a future window without publishing its samples before the track enters it", async () => {
    const fixture = setupWav();
    fixture.monitor.read("voice0");
    await vi.waitFor(() => expect(fixture.blobs.size).toBe(2));
    await Promise.all(blobReads);
    const future = FakeAudio.created.at(-1)!;
    future.readyState = 2;
    const context = FakeContext.created[0];
    fixture.monitor.sync();
    expect(future.paused).toBe(false);
    expect(future.volume).toBe(0);
    nativeProgress(future);
    expect(
      context.createMediaElementSource.mock.calls.map(([media]) => media),
    ).toContain(future);
    await fixture.ready();
    fixture.advance(14.25 - fixture.getTracks()[0].mediaSec!);
    expect(fixture.monitor.read("voice0")).toEqual(
      new Float32Array([3 / 64, -3 / 128]),
    );
    expect(fixture.blobs.size).toBe(2);
    fixture.advance(16.3 - fixture.getTracks()[0].mediaSec!);
    await fixture.ready();
    expect(
      context.createMediaElementSource.mock.calls.map(([media]) => media),
    ).toContain(future);
    expect(future.volume).toBe(1);
    expect(fixture.monitor.read("voice0")).toEqual(
      new Float32Array([1 / 64, -1 / 128]),
    );
    fixture.monitor.dispose();
    expect(fixture.blobs.size).toBe(0);
  });

  it.each([1, 3])(
    "revokes a %i-member local window after graph failure and never retries it",
    async (count) => {
      const fixture = setupWav(count);
      const revoke = vi.spyOn(URL, "revokeObjectURL");
      fixture.monitor.read("voice0");
      await vi.waitFor(() => expect(fixture.blobs.size).toBe(2));
      const media = FakeAudio.created[0];
      const context = FakeContext.created[0];
      vi.mocked(createChannelPeakTap).mockImplementationOnce(() => {
        throw new Error("tap failed");
      });
      media.readyState = 2;
      fixture.monitor.sync();
      nativeProgress(media);
      expect(media.src).toBe("");
      expect(media.volume).toBe(0);
      expect(media.paused).toBe(true);
      expect(fixture.blobs.size).toBe(0);
      expect(revoke).toHaveBeenCalledTimes(2);
      fixture.monitor.sync();
      nativeProgress(media);
      expect(fixture.monitor.read("voice0")).toBeNull();
      expect(context.createMediaElementSource).toHaveBeenCalledOnce();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.all(blobReads);
      for (let frame = 0; frame < 8; frame++) fixture.monitor.sync();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fixture.blobs.size).toBe(0);
      fixture.monitor.dispose();
      expect(revoke).toHaveBeenCalledTimes(2);
    },
  );

  it("silences a late local play settlement after its read URL changes", async () => {
    const fixture = setupWav();
    fixture.monitor.read("voice0");
    await vi.waitFor(() => expect(fixture.blobs.size).toBe(2));
    const media = FakeAudio.created[0];
    let finish: () => void = () => {};
    media.play.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            media.paused = false;
            resolve();
          };
        }),
    );
    media.readyState = 2;
    fixture.monitor.sync();
    fixture.setTracks(
      fixture
        .getTracks()
        .map((track) => ({ ...track, readUrl: "/stem/replacement" })),
      false,
    );
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(media.paused).toBe(true);
    expect(media.volume).toBe(0);
    nativeProgress(media);
    expect(
      FakeContext.created[0].createMediaElementSource,
    ).not.toHaveBeenCalled();
    expect(fixture.monitor.read("voice0")).toBeNull();
    fixture.monitor.dispose();
    expect(fixture.blobs.size).toBe(0);
  });

  it("keeps literal PCM unavailable until native progress and one tap of warmup", async () => {
    const fixture = setupWav();
    fixture.monitor.read("voice0");
    await vi.waitFor(() => expect(fixture.blobs.size).toBe(2));
    await Promise.all(blobReads);
    const media = FakeAudio.created[0];
    const context = FakeContext.created[0];
    media.readyState = 2;
    fixture.monitor.sync();
    await Promise.resolve();
    await Promise.resolve();
    fixture.advance();
    expect.soft(context.createMediaElementSource).not.toHaveBeenCalled();
    expect.soft(media.volume).toBe(0);
    expect.soft(fixture.monitor.read("voice0")).toBeNull();
    media.dispatchEvent(new Event("playing"));
    media.dispatchEvent(new Event("timeupdate"));
    expect.soft(context.createMediaElementSource).not.toHaveBeenCalled();
    media.currentTime += 0.01;
    media.dispatchEvent(new Event("timeupdate"));
    expect(context.createMediaElementSource.mock.calls).toEqual([[media]]);
    expect.soft(context.sourceVolumes).toEqual([0]);
    expect(media.volume).toBe(1);
    expect.soft(fixture.monitor.read("voice0")).toBeNull();
    fixture.advance();
    expect(fixture.monitor.read("voice0")).toEqual(
      new Float32Array([1 / 64, -1 / 128]),
    );
    fixture.monitor.dispose();
    expect(fixture.blobs.size).toBe(0);
  });

  it.each([
    "clock",
    "mute",
    "gap",
    "url",
    "readUrl",
    "remove",
    "dispose",
  ] as const)(
    "ignores local WAV progress after %s changes before the next sync",
    async (change) => {
      const fixture = setupWav();
      fixture.monitor.read("voice0");
      await vi.waitFor(() => expect(fixture.blobs.size).toBe(2));
      const media = FakeAudio.created[0];
      const context = FakeContext.created[0];
      media.readyState = 2;
      fixture.monitor.sync();
      await Promise.resolve();
      await Promise.resolve();
      media.dispatchEvent(new Event("playing"));
      if (change === "clock") fixture.setPlaying(false, false);
      else if (change === "dispose") fixture.monitor.dispose();
      else if (change === "remove") fixture.setTracks([], false);
      else
        fixture.setTracks(
          fixture.getTracks().map((track) => ({
            ...track,
            url: change === "url" ? "/stem/replacement" : track.url,
            readUrl:
              change === "readUrl" ? "/stem/replacement?read" : track.readUrl,
            gain: change === "mute" ? 0 : track.gain,
            mediaSec: change === "gap" ? null : track.mediaSec,
          })),
          false,
        );
      media.currentTime += 0.01;
      media.dispatchEvent(new Event("timeupdate"));
      media.dispatchEvent(new Event("playing"));
      media.currentTime += 0.01;
      media.dispatchEvent(new Event("timeupdate"));
      expect.soft(context.createMediaElementSource).not.toHaveBeenCalled();
      expect.soft(media.volume).toBe(0);
      fixture.monitor.sync();
      if (change === "mute" || change === "gap")
        expect(fixture.monitor.read("voice0")).toEqual(new Float32Array(2));
      else expect(fixture.monitor.read("voice0")).toBeNull();
      fixture.monitor.dispose();
      expect(fixture.blobs.size).toBe(0);
    },
  );
});

describe("bounded local WAV meter readers", () => {
  it("keeps current native samples intact when the reused tap captures a future clip", async () => {
    const frame = new Float32Array([0.25, -0.5]);
    vi.mocked(createChannelPeakTap).mockImplementationOnce(() => ({
      read: () => frame,
      dispose: vi.fn(),
    }));
    const fixture = setupWav();
    fixture.monitor.read("voice0");
    await fixture.ready();
    expect(fixture.monitor.read("voice0")).toEqual(
      new Float32Array([0.25, -0.5]),
    );
    frame.set([0.99, -0.99]);
    FakeContext.created[0].currentTime += 0.06;
    fixture.monitor.sync();
    expect(fixture.monitor.read("voice0")).toEqual(
      new Float32Array([0.25, -0.5]),
    );
    fixture.advance(0.08);
    expect(fixture.monitor.read("voice0")).toEqual(frame);
    fixture.monitor.dispose();
    expect(fixture.blobs.size).toBe(0);
  });

  it("withholds a pre-jump clip after a primary backward discontinuity without a sampled seeking state", async () => {
    let samples = new Float32Array([1, -1]);
    vi.mocked(createChannelPeakTap).mockImplementation(() => ({
      read: () => samples,
      dispose: vi.fn(),
    }));
    const fixture = setupWav();
    await fixture.ready();
    expect(fixture.monitor.read("voice0")).toEqual(new Float32Array([1, -1]));
    const target = fixture.getTracks()[0].mediaSec!;
    const context = FakeContext.created[0];
    context.currentTime += 0.04;
    fixture.move(target + 0.04);
    expect(fixture.monitor.read("voice0")).toEqual(new Float32Array([1, -1]));
    samples = new Float32Array([0.125, -0.0625]);
    context.currentTime += 0.01;
    fixture.move(target + 0.02);
    expect(fixture.monitor.read("voice0")).toBeNull();
    await fixture.ready();
    expect(fixture.monitor.read("voice0")).toEqual(
      new Float32Array([0.125, -0.0625]),
    );
    fixture.monitor.dispose();
  });

  it("assembles six stereo members into exact ordered native window bytes", async () => {
    const fixture = setupWav(6);
    for (let voice = 0; voice < 6; voice++)
      fixture.monitor.read(`voice${voice}`);
    await vi.waitFor(() => expect(fixture.blobs.size).toBeGreaterThan(0));
    await Promise.all(blobReads);
    const blocks = [...localBytes.values()];
    expect(blocks.length).toBeLessThanOrEqual(2);
    for (const data of blocks) {
      const view = new DataView(data);
      expect(view.getUint16(22, true)).toBe(12);
      expect(view.getUint16(32, true)).toBe(24);
      expect(data.byteLength - 44).toBeLessThanOrEqual(1048576);
      expect((data.byteLength - 44) % 24).toBe(0);
      for (let voice = 0; voice < 6; voice++) {
        expect(view.getInt16(44 + voice * 4, true)).toBe(512 * (voice + 1));
        expect(view.getInt16(46 + voice * 4, true)).toBe(-256 * (voice + 1));
      }
    }
    fixture.monitor.dispose();
    expect(fixture.blobs.size).toBe(0);
  });

  it("withholds all grouped pre-jump clips until actual progress and a full history warmup", async () => {
    let samples = new Float32Array([1, -1]);
    vi.mocked(createChannelPeakTap).mockImplementation(() => ({
      read: () => samples,
      dispose: vi.fn(),
    }));
    const fixture = setupWav(2);
    await fixture.ready();
    const media = FakeAudio.created.find((item) => item.src)!;
    const source = media.src;
    const context = FakeContext.created[0];
    const target = fixture.getTracks()[0].mediaSec!;
    context.currentTime += 0.04;
    fixture.move(target + 0.04);
    fixture.move(target + 0.02);
    const withheld = () => {
      expect(fixture.monitor.read("voice0")).toBeNull();
      expect(fixture.monitor.read("voice1")).toBeNull();
    };
    withheld();
    context.currentTime += 1;
    fixture.monitor.sync();
    withheld();
    media.currentTime += 0.04;
    media.dispatchEvent(new Event("timeupdate"));
    fixture.monitor.sync();
    withheld();
    context.currentTime += 2048 / context.sampleRate - 0.001;
    media.currentTime += 0.001;
    fixture.monitor.sync();
    withheld();
    samples = new Float32Array([0.125, -0.0625]);
    context.currentTime += 0.002;
    media.currentTime += 0.001;
    fixture.move(target + 0.05);
    for (const id of ["voice0", "voice1"])
      expect(fixture.monitor.read(id)).toEqual(
        new Float32Array([0.125, -0.0625]),
      );
    expect(media.src).toBe(source);
    expect(
      context.createMediaElementSource.mock.calls.filter(
        ([element]) => element === media,
      ),
    ).toHaveLength(1);
    fixture.monitor.dispose();
  });

  it("keeps six 48k stereo pairs discrete through bounded rolling windows and independent gains", async () => {
    const fixture = setupWav(6);
    for (let voice = 0; voice < 6; voice++)
      fixture.assets[voice] = literalPcm(48000, 48000 * 3, [
        1024 * (voice + 1),
        -512 * (voice + 1),
      ]);
    fixture.setTracks(
      fixture.getTracks().map((track, index) => ({
        ...track,
        mediaSec: 0.1,
        gain: index === 5 ? 0.5 : 1,
      })),
    );
    await fixture.ready();
    const assertLevels = () => {
      for (let voice = 0; voice < 6; voice++) {
        const gain = voice === 5 ? 0.5 : 1;
        expect(fixture.monitor.read(`voice${voice}`)).toEqual(
          new Float32Array([
            ((voice + 1) * gain) / 32,
            (-(voice + 1) * gain) / 64,
          ]),
        );
      }
      expect(fixture.blobs.size).toBeLessThanOrEqual(2);
      for (const data of localBytes.values()) {
        expect(data.byteLength).toBeLessThanOrEqual(1048576 + 44);
        expect(new DataView(data).getUint16(22, true)).toBe(12);
      }
    };
    assertLevels();
    for (let crossing = 0; crossing < 3; crossing++) {
      fixture.advance(0.4);
      await fixture.ready();
      assertLevels();
    }
    const context = FakeContext.created[0];
    expect(
      context.createMediaElementSource.mock.calls.length,
    ).toBeLessThanOrEqual(FakeAudio.created.length);
    const taps = vi
      .mocked(createChannelPeakTap)
      .mock.results.map((result) => result.value);
    fixture.monitor.dispose();
    fixture.monitor.dispose();
    for (const tap of taps) expect(tap.dispose).toHaveBeenCalledOnce();
    expect(fixture.blobs.size).toBe(0);
  });

  it("keeps a ready member live while another asset header is still pending", async () => {
    const fixture = setupWav(2);
    const other = fixture.getTracks()[1];
    fixture.setTracks(fixture.getTracks().slice(0, 1));
    await fixture.ready();
    let pending:
      | { call: RangeCall; resolve: (response: Response) => void }
      | undefined;
    fixture.setResponder((call) =>
      call.url.includes("voice1") && call.start === 0
        ? new Promise<Response>((resolve) => {
            pending = { call, resolve };
          })
        : fixture.response(call),
    );
    fixture.setTracks([
      ...fixture.getTracks(),
      { ...other, mediaSec: fixture.getTracks()[0].mediaSec },
    ]);
    fixture.monitor.read("voice1");
    await vi.waitFor(() => expect(pending).toBeDefined());
    fixture.advance(0.12);
    expect(fixture.monitor.read("voice0")).toEqual(
      new Float32Array([1 / 64, -1 / 128]),
    );
    expect(fixture.monitor.read("voice1")).toBeNull();
    pending!.resolve(fixture.response(pending!.call));
    await fixture.ready();
    expect(fixture.monitor.read("voice1")).toEqual(
      new Float32Array([1 / 32, -1 / 64]),
    );
    fixture.monitor.dispose();
  });

  it("replans a widened membership before allocating its larger interleave", async () => {
    const fixture = setupWav(6);
    const all = fixture.getTracks();
    fixture.setTracks(all.slice(0, 1));
    await fixture.ready();
    const old = FakeAudio.created.filter((media) => media.src);
    fixture.setTracks(all);
    await fixture.ready();
    for (const media of old) expect(media.src).toBe("");
    expect(fixture.blobs.size).toBeLessThanOrEqual(2);
    for (const data of localBytes.values()) {
      expect(data.byteLength).toBeLessThanOrEqual(1048576 + 44);
      expect(new DataView(data).getUint16(22, true)).toBe(12);
    }
    for (let voice = 0; voice < 6; voice++)
      expect(fixture.monitor.read(`voice${voice}`)).toEqual(
        new Float32Array([(voice + 1) / 64, -(voice + 1) / 128]),
      );
    fixture.monitor.dispose();
  });

  it("keeps mono silence and polarity without sharing incompatible sample rates", async () => {
    const fixture = setupWav(3);
    fixture.assets[0] = literalPcm(8000, 8000 * 3, [2048]);
    fixture.assets[1] = literalPcm(8000, 8000 * 3, [0, -4096]);
    fixture.assets[2] = literalPcm(48000, 48000 * 3, [8192, -8192]);
    fixture.move(0.1);
    await fixture.ready();
    expect(fixture.monitor.read("voice0")).toEqual(
      new Float32Array([1 / 16, 0]),
    );
    expect(fixture.monitor.read("voice1")).toEqual(
      new Float32Array([0, -1 / 8]),
    );
    expect(fixture.monitor.read("voice2")).toEqual(
      new Float32Array([1 / 4, -1 / 4]),
    );
    expect(
      new Set(
        [...localBytes.values()].map((data) =>
          new DataView(data).getUint16(22, true),
        ),
      ),
    ).toEqual(new Set([3, 2]));
    fixture.monitor.dispose();
  });

  it("ends a common window at the shorter asset without padding or dropping the longer member", async () => {
    const fixture = setupWav(2);
    fixture.assets[0] = literalPcm(8000, 8000, [2048, -1024]);
    fixture.assets[1] = literalPcm(8000, 8000 * 3, [4096, -2048]);
    fixture.move(0.1);
    await fixture.ready();
    expect(fixture.monitor.read("voice0")).toEqual(
      new Float32Array([1 / 16, -1 / 32]),
    );
    for (const data of localBytes.values())
      expect(data.byteLength - 44).toBeLessThanOrEqual(8000 * 8);
    fixture.move(1.25);
    expect(fixture.monitor.read("voice0")).toBeNull();
    await fixture.ready(["voice1"]);
    expect(fixture.monitor.read("voice0")).toBeNull();
    expect(fixture.monitor.read("voice1")).toEqual(
      new Float32Array([1 / 8, -1 / 16]),
    );
    fixture.monitor.dispose();
  });

  it("partitions the node channel dimension without imposing a project track cap", async () => {
    const fixture = setupWav(17);
    for (let voice = 0; voice < 17; voice++)
      fixture.assets[voice] = literalPcm(8000, 8000 * 2, [
        512 * (voice + 1),
        -256 * (voice + 1),
      ]);
    fixture.move(0.1);
    await fixture.ready();
    for (let voice = 0; voice < 17; voice++)
      expect(fixture.monitor.read(`voice${voice}`)).toEqual(
        new Float32Array([(voice + 1) / 64, -(voice + 1) / 128]),
      );
    expect(
      new Set(
        [...localBytes.values()].map((data) =>
          new DataView(data).getUint16(22, true),
        ),
      ),
    ).toEqual(new Set([32, 2]));
    expect(fixture.blobs.size).toBeLessThanOrEqual(4);
    fixture.monitor.dispose();
  });

  it.each(["replacement", "remove", "mute", "gap", "dispose"] as const)(
    "cancels every shared pending member on %s and rejects its late bytes",
    async (change) => {
      const fixture = setupWav(3);
      const held: { call: RangeCall; resolve: (response: Response) => void }[] =
        [];
      fixture.setResponder((call) =>
        call.url.includes("voice1") && call.end - call.start > 100
          ? new Promise<Response>((resolve) => held.push({ call, resolve }))
          : fixture.response(call),
      );
      fixture.monitor.read("voice0");
      await vi.waitFor(() => expect(held).toHaveLength(2));
      if (change === "dispose") fixture.monitor.dispose();
      else
        fixture.setTracks(
          fixture.getTracks().flatMap((track) => {
            if (track.id !== "voice1") return [track];
            if (change === "remove") return [];
            return [
              {
                ...track,
                url: change === "replacement" ? "/different" : track.url,
                gain: change === "mute" ? 0 : track.gain,
                mediaSec: change === "gap" ? null : track.mediaSec,
              },
            ];
          }),
        );
      expect(held.every(({ call }) => call.signal.aborted)).toBe(true);
      for (const pending of held)
        pending.resolve(fixture.response(pending.call));
      await Promise.resolve();
      await Promise.resolve();
      expect(
        FakeContext.created[0].createMediaElementSource,
      ).not.toHaveBeenCalled();
      fixture.monitor.dispose();
      expect(fixture.blobs.size).toBe(0);
    },
  );

  it("rejects changed member bytes while allowing only healthy replacement windows", async () => {
    const fixture = setupWav(3);
    fixture.setResponder((call) => {
      const response = fixture.response(call);
      if (call.url.includes("voice1") && call.end - call.start > 100)
        response.headers.set("ETag", '"replacement"');
      return response;
    });
    fixture.monitor.read("voice0");
    await vi.waitFor(() =>
      expect(
        fixture.calls.some(
          (call) => call.url.includes("voice1") && call.end - call.start > 100,
        ),
      ).toBe(true),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.monitor.read("voice0")).toBeNull();
    expect(fixture.monitor.read("voice1")).toBeNull();
    expect(fixture.blobs.size).toBeLessThanOrEqual(2);
    await Promise.all(blobReads);
    for (const bytes of localBytes.values())
      expect(new DataView(bytes).getUint16(22, true)).toBe(4);
    fixture.monitor.dispose();
    expect(fixture.blobs.size).toBe(0);
  });

  it.each(["range rejection", "identity change", "truncated body"] as const)(
    "regroups healthy native members after one %s without a playback reset or bad-asset retry",
    async (failure) => {
      const fixture = setupWav(3);
      await fixture.ready();
      const oldReaders = FakeAudio.created.filter((media) => media.src);
      for (let voice = 0; voice < 3; voice++)
        expect(fixture.monitor.read(`voice${voice}`)).toEqual(
          new Float32Array([(voice + 1) / 64, -(voice + 1) / 128]),
        );
      expect(
        [...localBytes.values()].some(
          (bytes) => new DataView(bytes).getUint16(22, true) === 6,
        ),
      ).toBe(true);
      let badRequests = 0;
      fixture.setResponder((call) => {
        const response = fixture.response(call);
        if (!call.url.includes("voice1") || call.end - call.start <= 100)
          return response;
        badRequests++;
        if (failure === "range rejection") throw new Error("one stem failed");
        if (failure === "identity change")
          response.headers.set("ETag", '"changed-stem"');
        if (failure === "truncated body")
          return new Response(new Uint8Array(1), {
            status: 206,
            headers: response.headers,
          });
        return response;
      });
      fixture.move(40.25);
      await vi.waitFor(() => expect(badRequests).toBeGreaterThan(0));
      expect(fixture.monitor.read("voice1")).toBeNull();
      await fixture.ready(["voice0", "voice2"]);
      expect(fixture.monitor.read("voice0")).toEqual(
        new Float32Array([1 / 64, -1 / 128]),
      );
      expect(fixture.monitor.read("voice2")).toEqual(
        new Float32Array([3 / 64, -3 / 128]),
      );
      expect(fixture.monitor.read("voice1")).toBeNull();
      for (const media of oldReaders) expect(media.src).toBe("");
      expect(fixture.blobs.size).toBeLessThanOrEqual(2);
      for (const bytes of localBytes.values())
        expect(new DataView(bytes).getUint16(22, true)).toBe(4);
      const failedCount = badRequests;
      fixture.advance(0.2);
      for (let frame = 0; frame < 8; frame++) {
        fixture.monitor.sync();
        expect(fixture.monitor.read("voice1")).toBeNull();
      }
      expect(badRequests).toBe(failedCount);
      fixture.monitor.dispose();
      expect(fixture.blobs.size).toBe(0);
    },
  );

  it("does not renew a stationary prepared sample and resumes on the same graph", async () => {
    let samples = new Float32Array([0.25, -0.5]);
    vi.mocked(createChannelPeakTap).mockImplementationOnce(() => ({
      read: () => samples,
      dispose: vi.fn(),
    }));
    const fixture = setupWav();
    await fixture.ready();
    const media = FakeAudio.created.find((item) => item.src)!;
    const url = media.src;
    const context = FakeContext.created[0];
    expect(fixture.monitor.read("voice0")).toEqual(
      new Float32Array([0.25, -0.5]),
    );

    const tick = (advance: number, contextAdvance = advance) => {
      fixture.setTracks(
        fixture.getTracks().map((track) => ({
          ...track,
          mediaSec: track.mediaSec! + advance,
        })),
        false,
      );
      context.currentTime += contextAdvance;
      fixture.monitor.sync();
      return fixture.monitor.read("voice0");
    };
    samples = new Float32Array([1, -1]);
    expect.soft(tick(0.06, 0.045)).toEqual(new Float32Array([0.25, -0.5]));
    expect.soft(tick(0.05)).toBeNull();

    samples = new Float32Array([0.5, -0.25]);
    for (const reader of FakeAudio.created)
      if (reader.src) reader.currentTime += 0.125;
    expect.soft(tick(0.02, 0.2)).toEqual(new Float32Array([0.5, -0.25]));
    expect.soft(media.src).toBe(url);
    expect(
      context.createMediaElementSource.mock.calls.filter(
        ([input]) => input === media,
      ),
    ).toHaveLength(1);
    fixture.monitor.dispose();
  });

  it("invalidates prepared history when the observed media position goes backwards", async () => {
    const fixture = setupWav();
    await fixture.ready();
    const media = FakeAudio.created.find((item) => item.src)!;
    expect(fixture.monitor.read("voice0")).toEqual(
      new Float32Array([1 / 64, -1 / 128]),
    );
    media.currentTime -= 0.005;
    fixture.monitor.sync();
    expect(fixture.monitor.read("voice0")).toBeNull();
    fixture.monitor.dispose();
  });

  it("lets a bound WAV reader progress without chasing an advancing primary", async () => {
    const fixture = setupWav();
    fixture.monitor.read("voice0");
    await fixture.ready();
    expect(fixture.monitor.read("voice0")).toEqual(
      new Float32Array([1 / 64, -1 / 128]),
    );
    const media = FakeAudio.created.find((item) => item.src)!;
    let position = media.currentTime;
    const writes: number[] = [];
    Object.defineProperty(media, "currentTime", {
      configurable: true,
      get: () => position,
      set: (value: number) => {
        writes.push(value);
        position = value;
        media.seeking = true;
      },
    });
    for (const primary of [12.45, 12.65, 12.85]) {
      position += 0.02;
      media.seeking = false;
      fixture.move(primary);
      expect(fixture.monitor.read("voice0")).toBeNull();
    }
    expect(writes).toEqual([]);
    expect(media.paused).toBe(false);
    fixture.monitor.dispose();
    expect(fixture.blobs.size).toBe(0);
  });

  it("recovers six literal fresh channel levels through resume, seeks and rolling crossings using only finite ranges", async () => {
    const fixture = setupWav(6);
    for (let voice = 0; voice < 6; voice++)
      expect(fixture.monitor.read(`voice${voice}`)).toBeNull();
    expect(vi.mocked(apiSend).mock.calls.length).toBe(6);
    await fixture.ready();
    const levels = (factor: number) => {
      for (let voice = 0; voice < 6; voice++)
        expect(fixture.monitor.read(`voice${voice}`)).toEqual(
          new Float32Array([(voice + 1) * factor, (-(voice + 1) * factor) / 2]),
        );
    };
    levels(1 / 64);
    expect(
      FakeAudio.created.every(
        (media) => media.src === "" || media.src.startsWith("blob:"),
      ),
    ).toBe(true);
    fixture.setRate(1.5);
    fixture.move(27.25, 2);
    expect(fixture.monitor.read("voice0")).toBeNull();
    await fixture.ready();
    levels(1 / 8);
    expect(
      FakeAudio.created
        .filter((media) => media.src)
        .every((media) => media.playbackRate === 1.5 && media.currentTime < 15),
    ).toBe(true);
    fixture.setPlaying(false);
    expect(fixture.monitor.read("voice0")).toBeNull();
    expect(fixture.blobs.size).toBe(0);
    fixture.setPlaying(true);
    fixture.move(0.25);
    await fixture.ready();
    levels(1 / 64);
    for (let second = 1; second <= 22; second++) {
      fixture.move(second + 0.25);
      await fixture.ready();
      levels((1 + (second % 4)) / 64);
      expect(fixture.blobs.size).toBeLessThanOrEqual(12);
    }
    expect(
      fixture.calls.every(
        (call) =>
          Number.isSafeInteger(call.end) &&
          call.end >= call.start &&
          call.end - call.start < 1_000_000,
      ),
    ).toBe(true);
    for (let voice = 0; voice < 6; voice++) {
      const calls = fixture.calls.filter((call) =>
        call.url.includes(`voice${voice}`),
      );
      expect(calls[0].url).toContain("rerender=true");
      expect(calls[1].url).toBe(`/stem/voice${voice}?hash=a`);
      expect(calls[1].validator).toBe('"asset-1"');
    }
    fixture.monitor.dispose();
    expect(fixture.blobs.size).toBe(0);
  });

  it("skips odd, large metadata without downloading its payload", async () => {
    const fixture = setupWav(1, wavBytes(0, 500_001));
    fixture.monitor.read("voice0");
    await fixture.ready();
    expect(fixture.monitor.read("voice0")).toEqual(
      new Float32Array([1 / 64, -1 / 128]),
    );
    expect(fixture.calls.some((call) => call.start === 500_022)).toBe(true);
    expect(
      fixture.calls.every((call) => call.start >= 500_022 || call.end <= 19),
    ).toBe(true);
    fixture.monitor.dispose();
  });

  it.each([200, 404, 416])(
    "cancels HTTP %s at headers without reading its body",
    async (status) => {
      const fixture = setupWav();
      const cancel = vi.fn(async () => {});
      const getReader = vi.fn();
      fixture.setResponder(
        () =>
          ({
            status,
            headers: new Headers(),
            body: { cancel, getReader },
          }) as unknown as Response,
      );
      fixture.monitor.read("voice0");
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
      expect(getReader).not.toHaveBeenCalled();
      expect(fixture.calls[0].signal.aborted).toBe(true);
      expect(fixture.monitor.read("voice0")).toBeNull();
      expect(FakeAudio.created).toHaveLength(0);
      fixture.monitor.dispose();
    },
  );

  it.each(["range", "length", "etag", "encoding", "total"])(
    "rejects a changed %s before consuming continuation bytes",
    async (kind) => {
      const fixture = setupWav();
      const cancel = vi.fn(async () => {});
      const getReader = vi.fn();
      fixture.setResponder((call) => {
        const response = fixture.response(call);
        if (call.start === 0) return response;
        if (kind === "range")
          response.headers.set(
            "Content-Range",
            `bytes ${call.start + 1}-${call.end}/3840056`,
          );
        if (kind === "length")
          response.headers.set("Content-Length", "999999999");
        if (kind === "etag") response.headers.set("ETag", '"asset-2"');
        if (kind === "encoding")
          response.headers.set("Content-Encoding", "gzip");
        if (kind === "total")
          response.headers.set(
            "Content-Range",
            `bytes ${call.start}-${call.end}/999999999`,
          );
        return {
          status: response.status,
          headers: response.headers,
          body: { cancel, getReader },
        } as unknown as Response;
      });
      fixture.monitor.read("voice0");
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
      expect(getReader).not.toHaveBeenCalled();
      expect(fixture.monitor.read("voice0")).toBeNull();
      expect(fixture.calls.at(-1)!.signal.aborted).toBe(true);
      fixture.monitor.dispose();
    },
  );

  it.each([-1, 1])(
    "rejects body length differing by %s byte",
    async (difference) => {
      const fixture = setupWav();
      fixture.setResponder((call) => {
        const valid = fixture.response(call);
        return new Response(
          new Uint8Array(call.end - call.start + 1 + difference),
          { status: 206, headers: valid.headers },
        );
      });
      fixture.monitor.read("voice0");
      await vi.waitFor(() =>
        expect(fixture.calls[0].signal.aborted).toBe(true),
      );
      expect(fixture.monitor.read("voice0")).toBeNull();
      expect(fixture.blobs.size).toBe(0);
      fixture.monitor.dispose();
    },
  );

  it.each(["format", "alignment", "data-size", "chunk-extent", "riff"])(
    "rejects malformed WAV %s without native remote fallback",
    async (kind) => {
      const bytes = wavBytes();
      const view = new DataView(bytes.buffer);
      if (kind === "format") view.setUint16(32, 65534, true);
      if (kind === "alignment") view.setUint16(44, 2, true);
      if (kind === "data-size") view.setUint32(52, bytes.length - 57, true);
      if (kind === "chunk-extent") view.setUint32(16, 0xfffffff0, true);
      if (kind === "riff") view.setUint32(4, 0xffffffff, true);
      const fixture = setupWav(1, bytes);
      fixture.monitor.read("voice0");
      await vi.waitFor(() =>
        expect(fixture.calls.at(-1)?.signal.aborted).toBe(true),
      );
      expect(fixture.monitor.read("voice0")).toBeNull();
      expect(FakeAudio.created).toHaveLength(0);
      fixture.monitor.dispose();
    },
  );

  it.each(["pause", "remove", "url", "dispose"])(
    "discards an uncancellable late response after %s",
    async (action) => {
      const fixture = setupWav();
      let resolve: (response: Response) => void = () => {};
      fixture.setResponder(
        () =>
          new Promise<Response>((done) => {
            resolve = done;
          }),
      );
      fixture.monitor.read("voice0");
      const first = fixture.calls[0];
      if (action === "pause") fixture.setPlaying(false);
      if (action === "remove") fixture.setTracks([]);
      if (action === "url")
        fixture.setTracks(
          fixture
            .getTracks()
            .map((track) => ({ ...track, url: `${track.url}2` })),
        );
      if (action === "dispose") fixture.monitor.dispose();
      expect(first.signal.aborted).toBe(true);
      const response = fixture.response(first);
      const cancel = vi.spyOn(response.body!, "cancel");
      resolve(response);
      await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
      expect(fixture.blobs.size).toBe(0);
      expect(fixture.monitor.read("voice0")).toBeNull();
      fixture.monitor.dispose();
    },
  );

  it("uses current gain/rate after a late window and never exposes stale seek, mute or gap samples", async () => {
    const fixture = setupWav();
    fixture.monitor.read("voice0");
    fixture.move(12.25, 2);
    fixture.setRate(2);
    await fixture.ready();
    expect(fixture.monitor.read("voice0")).toEqual(
      new Float32Array([1 / 32, -1 / 64]),
    );
    const media = FakeAudio.created.find((item) => item.src)!;
    expect(media.playbackRate).toBe(2);
    media.seeking = true;
    expect(fixture.monitor.read("voice0")).toBeNull();
    media.seeking = false;
    fixture.move(12.25, 0);
    expect(fixture.monitor.read("voice0")).toEqual(new Float32Array(2));
    fixture.move(null);
    expect(fixture.monitor.read("voice0")).toEqual(new Float32Array(2));
    fixture.move(13.25);
    expect(fixture.monitor.read("voice0")).toBeNull();
    await fixture.ready();
    expect(fixture.monitor.read("voice0")).toEqual(
      new Float32Array([1 / 32, -1 / 64]),
    );
    fixture.monitor.dispose();
  });

  it("recovers literal PCM samples after a non-unity gain change", async () => {
    const fixture = setupWav();
    fixture.monitor.read("voice0");
    await fixture.ready();
    expect(fixture.monitor.read("voice0")).toEqual(
      new Float32Array([0.015625, -0.0078125]),
    );

    fixture.move(fixture.getTracks()[0].mediaSec, 0.5623413251903491);
    expect(fixture.monitor.read("voice0")).toBeNull();
    fixture.advance();
    expect(fixture.monitor.read("voice0")).toEqual(
      new Float32Array([0.008786583319306374, -0.004393291659653187]),
    );
    fixture.monitor.dispose();
  });
});

describe("WAV window lifetime controls", () => {
  it("excludes a run observed below native readiness even without a media event", async () => {
    const fixture = setupWav();
    fixture.monitor.read("voice0");
    await fixture.ready();
    const media = FakeAudio.created.find((item) => item.src)!;
    media.readyState = 1;
    fixture.monitor.sync();
    const context = FakeContext.created[0];
    context.currentTime += 0.5;
    fixture.setTracks(
      fixture
        .getTracks()
        .map((track) => ({ ...track, mediaSec: track.mediaSec! + 0.5 })),
    );
    media.readyState = 2;
    expect(fixture.monitor.read("voice0")).toBeNull();
    await fixture.ready();
    expect(fixture.monitor.read("voice0")).toEqual(
      new Float32Array([1 / 64, -1 / 128]),
    );
    fixture.monitor.dispose();
    expect(fixture.blobs.size).toBe(0);
  });

  it.each([
    ["pause", "ended"],
    ["ended", "pause"],
  ])(
    "retains already captured native EOF history for %s then %s",
    async (first, second) => {
      const fixture = setupWav();
      fixture.monitor.read("voice0");
      await fixture.ready();
      const media = FakeAudio.created.find((item) => item.src)!;
      media.ended = true;
      media.paused = true;
      media.dispatchEvent(new Event(first));
      media.dispatchEvent(new Event(second));
      expect(fixture.monitor.read("voice0")).toEqual(
        new Float32Array([1 / 64, -1 / 128]),
      );
      fixture.monitor.dispose();
      expect(fixture.blobs.size).toBe(0);
    },
  );

  it("discards late pending windows after a context interruption before any reader binds", async () => {
    const fixture = setupWav();
    const pending: {
      call: RangeCall;
      resolve: (response: Response) => void;
    }[] = [];
    fixture.setResponder((call) =>
      call.start >= 56
        ? new Promise<Response>((resolve) => pending.push({ call, resolve }))
        : fixture.response(call),
    );
    fixture.monitor.read("voice0");
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    const context = FakeContext.created[0];
    context.state = "interrupted";
    context.dispatchEvent(new Event("statechange"));
    for (const item of pending) {
      expect.soft(item.call.signal.aborted).toBe(true);
      item.resolve(fixture.response(item.call));
    }
    await vi.waitFor(() => expect(fixture.blobs.size).toBe(0));
    expect(context.createMediaElementSource).not.toHaveBeenCalled();
    expect(fixture.monitor.read("voice0")).toBeNull();
    context.state = "running";
    context.dispatchEvent(new Event("statechange"));
    fixture.setResponder(fixture.response);
    await fixture.ready();
    expect(fixture.monitor.read("voice0")).toEqual(
      new Float32Array([1 / 64, -1 / 128]),
    );
    fixture.monitor.dispose();
    expect(fixture.blobs.size).toBe(0);
  });

  it("ignores priming progress delivered after a context interruption", async () => {
    const fixture = setupWav();
    fixture.monitor.read("voice0");
    await vi.waitFor(() => expect(fixture.blobs.size).toBe(2));
    await Promise.all(blobReads);
    const media = FakeAudio.created.find((item) => item.src)!;
    media.readyState = 2;
    fixture.monitor.sync();
    const context = FakeContext.created[0];
    context.state = "interrupted";
    context.dispatchEvent(new Event("statechange"));
    nativeProgress(media);
    expect.soft(context.createMediaElementSource).not.toHaveBeenCalled();
    expect.soft(fixture.monitor.read("voice0")).toBeNull();
    context.state = "running";
    context.dispatchEvent(new Event("statechange"));
    await fixture.ready();
    expect(fixture.monitor.read("voice0")).toEqual(
      new Float32Array([1 / 64, -1 / 128]),
    );
    fixture.monitor.dispose();
    expect(fixture.blobs.size).toBe(0);
  });

  it("withholds samples without moving any current or ahead prepared reader during an eventless freeze", async () => {
    const fixture = setupWav();
    await fixture.ready();
    expect(fixture.monitor.read("voice0")).toEqual(
      new Float32Array([1 / 64, -1 / 128]),
    );
    const readers = FakeAudio.created.filter((media) => media.src);
    expect(readers).toHaveLength(2);
    const initialTimes = readers.map((media) => media.currentTime);
    const context = FakeContext.created[0];
    const primary = fixture.getTracks()[0].mediaSec!;
    let samples: ArrayLike<number> | null = null;
    for (let frame = 1; frame <= 8; frame++) {
      context.currentTime += 0.016;
      fixture.setTracks(
        fixture.getTracks().map((track) => ({
          ...track,
          mediaSec: primary + frame * 0.016,
        })),
        false,
      );
      fixture.monitor.sync();
      samples = fixture.monitor.read("voice0");
    }
    expect(readers.map((media) => media.currentTime)).toEqual(initialTimes);
    expect(samples).toBeNull();
    fixture.monitor.dispose();
  });

  it("recovers an eventless prepared-clock freeze on the same bound graph", async () => {
    const bytes = wavBytes();
    const pcm = new DataView(bytes.buffer, bytes.length - 120 * 8000 * 4);
    for (let frame = 12.4 * 8000; frame < 13 * 8000; frame++) {
      pcm.setInt16(frame * 4, 1536, true);
      pcm.setInt16(frame * 4 + 2, -768, true);
    }
    const fixture = setupWav(1, bytes);
    await fixture.ready();
    expect(fixture.monitor.read("voice0")).toEqual(
      new Float32Array([1 / 64, -1 / 128]),
    );
    const context = FakeContext.created[0];
    const media = FakeAudio.created.find((reader) => reader.src)!;
    const url = media.src;
    let position = media.currentTime;
    const frozenAt = position;
    const writes: number[] = [];
    Object.defineProperty(media, "currentTime", {
      get: () => position,
      set: (next: number) => {
        writes.push(next);
        media.seeking = true;
        media.dispatchEvent(new Event("seeking"));
      },
    });
    const frame = (advance: number, mediaAdvance = 0) => {
      position += mediaAdvance;
      context.currentTime += advance;
      fixture.setTracks(
        fixture.getTracks().map((track) => ({
          ...track,
          mediaSec: track.mediaSec! + advance,
        })),
        false,
      );
      fixture.monitor.sync();
      return fixture.monitor.read("voice0");
    };
    for (let tick = 0; tick < 12; tick++) frame(0.016);

    expect(position).toBe(frozenAt);
    expect.soft(media.src).toBe(url);
    expect.soft(fixture.blobs.has(url)).toBe(true);
    expect.soft(fixture.monitor.read("voice0")).toBeNull();
    expect(writes).toEqual([]);

    expect(frame(0.016, 0.012)).toBeNull();
    for (let tick = 0; tick < 2; tick++) expect(frame(0.016)).toBeNull();
    expect(frame(0.05, 0.25)).toEqual(new Float32Array([3 / 64, -3 / 128]));
    expect(media.src).toBe(url);
    expect(
      context.createMediaElementSource.mock.calls.filter(
        ([input]) => input === media,
      ),
    ).toHaveLength(1);
    for (let tick = 0; tick < 7; tick++) frame(0.016);
    expect(fixture.monitor.read("voice0")).toBeNull();
    expect(media.src).toBe(url);
    expect(writes).toEqual([]);
    fixture.monitor.dispose();
  });

  it.each(["waiting", "stalled", "pause", "seeking"])(
    "retires a prepared run after the native %s event and recovers with a fresh reader",
    async (event) => {
      const fixture = setupWav();
      fixture.monitor.read("voice0");
      await fixture.ready();
      const media = FakeAudio.created.find((item) => item.src)!;
      if (event === "pause") media.pause();
      else if (event === "seeking") media.seeking = true;
      else media.readyState = 1;
      media.dispatchEvent(new Event(event));
      fixture.monitor.sync();
      expect.soft(fixture.monitor.read("voice0")).toBeNull();
      const context = FakeContext.created[0];
      context.currentTime += 0.5;
      fixture.setTracks(
        fixture
          .getTracks()
          .map((track) => ({ ...track, mediaSec: track.mediaSec! + 0.5 })),
      );
      media.readyState = 2;
      if (event === "seeking") {
        media.seeking = false;
        media.dispatchEvent(new Event("seeked"));
      }
      nativeProgress(media);
      expect.soft(fixture.monitor.read("voice0")).toBeNull();
      await fixture.ready();
      expect(fixture.monitor.read("voice0")).toEqual(
        new Float32Array([1 / 64, -1 / 128]),
      );
      expect(fixture.blobs.size).toBeLessThanOrEqual(2);
      fixture.monitor.dispose();
      expect(fixture.blobs.size).toBe(0);
    },
  );

  it.each(["interrupted", "suspended"])(
    "retires prepared windows on context %s and recovers only after running",
    async (state) => {
      const fixture = setupWav();
      fixture.monitor.read("voice0");
      await fixture.ready();
      const context = FakeContext.created[0];
      const readers = FakeAudio.created.filter((item) => item.src);
      context.state = state;
      context.dispatchEvent(new Event("statechange"));
      expect.soft(fixture.monitor.read("voice0")).toBeNull();
      expect.soft(fixture.blobs.size).toBe(0);
      for (const media of readers) nativeProgress(media);
      expect(fixture.monitor.read("voice0")).toBeNull();
      context.currentTime += 0.5;
      fixture.setTracks(
        fixture
          .getTracks()
          .map((track) => ({ ...track, mediaSec: track.mediaSec! + 0.5 })),
        false,
      );
      context.state = "running";
      context.dispatchEvent(new Event("statechange"));
      expect.soft(fixture.monitor.read("voice0")).toBeNull();
      await fixture.ready();
      expect(fixture.monitor.read("voice0")).toEqual(
        new Float32Array([1 / 64, -1 / 128]),
      );
      expect(fixture.blobs.size).toBeLessThanOrEqual(2);
      fixture.monitor.dispose();
      expect(fixture.blobs.size).toBe(0);
    },
  );

  it("replaces an unexpectedly seeking reader and ignores its late seeked and progress events", async () => {
    const fixture = setupWav();
    fixture.monitor.read("voice0");
    await fixture.ready();
    const media = FakeAudio.created.find((item) => item.src)!;
    const context = FakeContext.created[0];
    const bindings = () =>
      context.createMediaElementSource.mock.calls.filter(
        ([item]) => item === media,
      ).length;
    expect(bindings()).toBe(1);
    media.seeking = true;
    media.dispatchEvent(new Event("seeking"));
    fixture.monitor.sync();
    expect(fixture.monitor.read("voice0")).toBeNull();
    media.seeking = false;
    media.currentTime += 0.5;
    media.dispatchEvent(new Event("seeked"));
    nativeProgress(media);
    expect(bindings()).toBe(1);
    expect(fixture.monitor.read("voice0")).toBeNull();
    await fixture.ready();
    expect(fixture.monitor.read("voice0")).toEqual(
      new Float32Array([1 / 64, -1 / 128]),
    );
    expect(fixture.blobs.size).toBeLessThanOrEqual(2);
    fixture.monitor.dispose();
    expect(fixture.blobs.size).toBe(0);
  });

  it("replaces a retired pending window when playback returns before sync", async () => {
    const fixture = setupWav();
    const pending: {
      call: RangeCall;
      resolve: (response: Response) => void;
    }[] = [];
    fixture.setResponder((call) =>
      call.start >= 56
        ? new Promise<Response>((resolve) => {
            pending.push({ call, resolve });
          })
        : fixture.response(call),
    );
    fixture.monitor.read("voice0");
    await vi.waitFor(() => expect(pending).toHaveLength(2));

    const tracks = fixture.getTracks();
    fixture.setTracks(
      tracks.map((track) => ({ ...track, mediaSec: 90 })),
      false,
    );
    for (const item of pending) item.resolve(fixture.response(item.call));
    await vi.waitFor(() => {
      for (const item of pending) expect(item.call.signal.aborted).toBe(true);
    });

    fixture.setTracks(tracks, false);
    fixture.setResponder(fixture.response);
    await fixture.ready();
    expect(fixture.monitor.read("voice0")).toEqual(
      new Float32Array([1 / 64, -1 / 128]),
    );
    fixture.monitor.dispose();
  });

  it("counts pending windows in the two-slot bound and retires them before an out-of-window seek", async () => {
    const fixture = setupWav();
    fixture.monitor.read("voice0");
    await fixture.ready();
    expect(fixture.monitor.read("voice0")).toEqual(
      new Float32Array([1 / 64, -1 / 128]),
    );
    const pending: {
      call: RangeCall;
      resolve: (response: Response) => void;
    }[] = [];
    fixture.setResponder(
      (call) =>
        new Promise<Response>((resolve) => {
          pending.push({ call, resolve });
        }),
    );
    fixture.move(15.25);
    fixture.monitor.read("voice0");
    expect(pending).toHaveLength(1);
    for (let turn = 0; turn < 8; turn++) fixture.monitor.sync();
    expect(pending).toHaveLength(1);
    expect(
      fixture.blobs.size +
        pending.filter((item) => !item.call.signal.aborted).length,
    ).toBe(2);
    fixture.move(90.25);
    expect(pending[0].call.signal.aborted).toBe(true);
    expect(
      fixture.blobs.size +
        pending.filter((item) => !item.call.signal.aborted).length,
    ).toBeLessThanOrEqual(2);
    expect(fixture.monitor.read("voice0")).toBeNull();
    const stale = fixture.response(pending[0].call);
    const cancel = vi.spyOn(stale.body!, "cancel");
    pending[0].resolve(stale);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(fixture.blobs.size).toBe(0);
    fixture.setResponder(fixture.response);
    for (const item of pending.slice(1))
      item.resolve(fixture.response(item.call));
    await fixture.ready();
    expect(fixture.monitor.read("voice0")).toEqual(
      new Float32Array([3 / 64, -3 / 128]),
    );
    fixture.monitor.dispose();
  });

  it("cancels a body already being streamed when the clock disappears", async () => {
    const fixture = setupWav();
    const cancel = vi.fn();
    let delivered = false;
    fixture.setResponder(
      (call) =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (!delivered) {
                controller.enqueue(new Uint8Array([82]));
                delivered = true;
              }
            },
            cancel,
          }),
          { status: 206, headers: fixture.response(call).headers },
        ),
    );
    fixture.monitor.read("voice0");
    await vi.waitFor(() => expect(delivered).toBe(true));
    fixture.setPlaying(false);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(fixture.calls[0].signal.aborted).toBe(true);
    expect(fixture.monitor.read("voice0")).toBeNull();
    fixture.setResponder(fixture.response);
    fixture.setPlaying(true);
    await fixture.ready();
    expect(fixture.monitor.read("voice0")).toEqual(
      new Float32Array([1 / 64, -1 / 128]),
    );
    fixture.monitor.dispose();
  });

  it("invalidates cached samples when a data response changes the header asset validator", async () => {
    const fixture = setupWav();
    fixture.monitor.read("voice0");
    await fixture.ready();
    expect(fixture.monitor.read("voice0")).toEqual(
      new Float32Array([1 / 64, -1 / 128]),
    );
    const cancel = vi.fn(async () => {});
    const getReader = vi.fn();
    fixture.setResponder((call) => {
      const headers = fixture.response(call).headers;
      headers.set("ETag", '"replacement"');
      return {
        status: 206,
        headers,
        body: { cancel, getReader },
      } as unknown as Response;
    });
    fixture.move(15.25);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(getReader).not.toHaveBeenCalled();
    expect(fixture.monitor.read("voice0")).toBeNull();
    expect(fixture.blobs.size).toBe(0);
    fixture.monitor.dispose();
  });

  it("reopens with the action URL once per resumed asset and never for subsequent windows", async () => {
    const fixture = setupWav();
    fixture.monitor.read("voice0");
    await fixture.ready();
    fixture.move(40.25);
    await fixture.ready();
    expect(fixture.monitor.read("voice0")).toEqual(
      new Float32Array([1 / 64, -1 / 128]),
    );
    expect(
      fixture.calls.filter((call) => call.url.includes("rerender=true")),
    ).toHaveLength(1);
    fixture.setPlaying(false);
    fixture.setPlaying(true);
    await fixture.ready();
    expect(
      fixture.calls.filter((call) => call.url.includes("rerender=true")),
    ).toHaveLength(2);
    expect(fixture.monitor.read("voice0")).toEqual(
      new Float32Array([1 / 64, -1 / 128]),
    );
    fixture.move(120);
    expect(fixture.monitor.read("voice0")).toBeNull();
    expect(fixture.blobs.size).toBe(0);
    fixture.monitor.dispose();
  });

  it("keeps discovery after playback advances within the same asset", async () => {
    const fixture = setupWav();
    let pending:
      | { call: RangeCall; resolve: (response: Response) => void }
      | undefined;
    fixture.setResponder((call) => {
      if (call.start === 0 && !pending)
        return new Promise<Response>((resolve) => {
          pending = { call, resolve };
        });
      return fixture.response(call);
    });
    fixture.monitor.read("voice0");
    await vi.waitFor(() => expect(pending).toBeDefined());

    fixture.move(18.25);
    fixture.monitor.read("voice0");
    pending!.resolve(fixture.response(pending!.call));

    await fixture.ready();
    expect(fixture.monitor.read("voice0")).toEqual(
      new Float32Array([3 / 64, -3 / 128]),
    );
    expect(
      fixture.calls.filter((call) => call.url.includes("rerender=true")),
    ).toHaveLength(1);
    fixture.monitor.dispose();
  });
});

it.each([
  ["discovery", "clock"],
  ["discovery", "mute"],
  ["discovery", "gap"],
  ["window", "clock"],
  ["window", "mute"],
  ["window", "gap"],
])(
  "retires %s completing during an unobserved %s gap and recovers",
  async (phase, reason) => {
    const fixture = setupWav();
    let pending:
      | { call: RangeCall; resolve: (response: Response) => void }
      | undefined;
    fixture.setResponder((call) => {
      const hold =
        phase === "discovery" ? call.start === 48 : call.end - call.start > 16;
      return hold
        ? new Promise<Response>((resolve) => {
            pending = { call, resolve };
          })
        : fixture.response(call);
    });
    fixture.monitor.read("voice0");
    await vi.waitFor(() => expect(pending?.call.start).toBeGreaterThan(0));
    const tracks = fixture.getTracks();
    if (reason === "clock") fixture.setPlaying(false, false);
    else
      fixture.setTracks(
        tracks.map((track) => ({
          ...track,
          gain: reason === "mute" ? 0 : 1,
          mediaSec: reason === "gap" ? null : track.mediaSec,
        })),
        false,
      );
    pending!.resolve(fixture.response(pending!.call));
    await vi.waitFor(() => expect(pending!.call.signal.aborted).toBe(true));
    expect(fixture.blobs.size).toBe(0);
    fixture.setResponder(fixture.response);
    fixture.setTracks(tracks);
    fixture.setPlaying(true);
    await fixture.ready();
    expect(fixture.monitor.read("voice0")).toEqual(
      new Float32Array([1 / 64, -1 / 128]),
    );
    fixture.monitor.dispose();
  },
);
