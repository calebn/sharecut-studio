import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHostPlaybackMeterMonitor,
  type HostMeterTrack,
} from "./hostPlaybackMeterMonitor";

vi.mock("./channelPeakTap", () => ({
  createChannelPeakTap: (
    _context: unknown,
    node: { gain: { value: number } },
  ) => ({
    read: () =>
      new Float32Array([0.5 * node.gain.value, -0.25 * node.gain.value]),
    dispose: vi.fn(),
  }),
}));

class FakeAudio extends EventTarget {
  static created: FakeAudio[] = [];
  currentTime = 0;
  readyState = 0;
  seeking = false;
  paused = true;
  playbackRate = 1;
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

class FakeContext {
  static created: FakeContext[] = [];
  static failGain = false;
  state = "running";
  close = vi.fn(async () => {});
  resume = vi.fn(async () => {});
  suspend = vi.fn(async () => {});
  source = { connect: vi.fn(), disconnect: vi.fn() };
  gain = { gain: { value: 1 }, disconnect: vi.fn() };
  createMediaElementSource = vi.fn(() => this.source);
  createGain = vi.fn(() => {
    if (FakeContext.failGain) throw new Error("graph unavailable");
    return this.gain;
  });
  constructor() {
    FakeContext.created.push(this);
  }
}

function setup() {
  let playing = true;
  let rate = 1;
  let tracks: HostMeterTrack[] = [
    { id: "host", url: "/stem/host", gain: 2, mediaSec: 12 },
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
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("AudioContext", FakeContext);
});
afterEach(() => vi.unstubAllGlobals());

describe("host playback meter monitor", () => {
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
    expect(monitor.read("host")).toEqual(new Float32Array([1, -0.5]));
    expect(media.currentTime).toBe(12);
    expect(FakeContext.created[0].gain.gain.value).toBe(2);
    setRate(1.5);
    setTracks([{ id: "host", url: "/stem/host", gain: 0.5, mediaSec: 24 }]);
    monitor.sync();
    expect(monitor.read("host")).toEqual(new Float32Array([0.25, -0.125]));
    expect(media.currentTime).toBe(24);
    expect(media.playbackRate).toBe(1.5);
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
    monitor.read("host");
    setPlaying(false);
    monitor.sync();
    expect(media.paused).toBe(true);
    expect(monitor.read("host")).toBeNull();
    monitor.dispose();
  });

  it("returns verified zero for mute and source-clock gaps without loading audio", () => {
    const { monitor, setTracks } = setup();
    setTracks([{ id: "host", url: "/raw/host", gain: 0, mediaSec: 5 }]);
    monitor.sync();
    expect(monitor.read("host")).toEqual(new Float32Array(2));
    setTracks([{ id: "host", url: "/raw/host", gain: 1, mediaSec: null }]);
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
    const media = FakeAudio.created[0];
    media.readyState = 2;
    let rejectPlay: (error: Error) => void = () => {};
    media.play.mockImplementationOnce(
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
    monitor.sync();
    expect(media.play).toHaveBeenCalledTimes(2);
    expect(monitor.read("host")).toEqual(new Float32Array([1, -0.5]));
    monitor.dispose();
  });

  it("suspends the graph on pause and resumes it on playback", () => {
    const { monitor, setPlaying } = setup();
    monitor.read("host");
    const context = FakeContext.created[0];
    setPlaying(false);
    monitor.sync();
    expect(context.suspend).toHaveBeenCalledOnce();
    context.state = "suspended";
    setPlaying(true);
    monitor.sync();
    expect(context.resume).toHaveBeenCalledOnce();
    monitor.dispose();
  });

  it("releases partial graphs when audio node construction fails", () => {
    const { monitor } = setup();
    FakeContext.failGain = true;
    expect(monitor.read("host")).toBeNull();
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
    setTracks([{ id: "host", url: "/raw/host", gain: 1, mediaSec: 40 }]);
    monitor.sync();
    monitor.read("host");
    expect(original.src).toBe("");
    expect(original.pause).toHaveBeenCalled();
    expect(FakeAudio.created).toHaveLength(2);
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
