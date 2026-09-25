import { afterEach, describe, expect, it, vi } from "vitest";
import { attachKeeperTap, openKeeperTap } from "./graph";

type FakeWorklet = { port: { onmessage: unknown } };
const nodes: FakeWorklet[] = [];
const closeSpy = vi.fn();

function install(rejects: number) {
  let left = rejects;
  class Ctx {
    state = "suspended";
    sampleRate = 48000;
    destination = {};
    audioWorklet = { addModule: vi.fn(async () => undefined) };
    async resume() {
      if (left > 0) {
        left -= 1;
        throw new Error("blocked");
      }
      this.state = "running";
    }
    close = closeSpy;
    createMediaStreamSource() {
      return { connect: () => undefined, disconnect: () => undefined };
    }
    createGain() {
      return {
        gain: { value: 1 },
        connect: () => undefined,
        disconnect: () => undefined,
      };
    }
  }
  class Worklet {
    port = { onmessage: null as unknown };
    constructor() {
      nodes.push(this);
    }
    connect() {
      return undefined;
    }
    disconnect() {
      return undefined;
    }
  }
  vi.stubGlobal("AudioContext", Ctx);
  vi.stubGlobal("AudioWorkletNode", Worklet);
}

afterEach(() => {
  vi.unstubAllGlobals();
  nodes.length = 0;
  closeSpy.mockClear();
});

const stream = {} as MediaStream;

describe("openKeeperTap", () => {
  it("opens despite rejected resumes and resume() recovers", async () => {
    install(2);
    const tap = await openKeeperTap(stream, () => undefined);
    expect(await tap.resume()).toBe("running");
  });
  it("reports suspended without throwing", async () => {
    install(Number.POSITIVE_INFINITY);
    const tap = await openKeeperTap(stream, () => undefined);
    expect(await tap.resume()).toBe("suspended");
  });
  it("forwards pcm and stop cleans up", async () => {
    install(0);
    const onPcm = vi.fn();
    const tap = await openKeeperTap(stream, onPcm);
    const data = new Float32Array(4);
    const node = nodes[0];
    (node?.port.onmessage as (e: { data: Float32Array }) => void)({ data });
    expect(onPcm).toHaveBeenCalledWith(data, 48000);
    tap.stop();
    expect(node?.port.onmessage).toBeNull();
    expect(closeSpy).toHaveBeenCalled();
  });
  it("attachKeeperTap returns a stop function", async () => {
    install(0);
    const stop = await attachKeeperTap(stream, () => undefined);
    stop();
    expect(closeSpy).toHaveBeenCalled();
  });
});
