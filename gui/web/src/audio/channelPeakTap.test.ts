import { describe, expect, it, vi } from "vitest";
import { createChannelPeakTap } from "./channelPeakTap";
import { peakDbFromSamples } from "./metering";

describe("separate playback channels", () => {
  it("keeps anti-phase stereo peaks and disconnects the silent analysis branch", () => {
    const left = new Float32Array(2048).fill(0.9);
    const right = new Float32Array(2048).fill(-0.9);
    const splitter = { connect: vi.fn(), disconnect: vi.fn() };
    const sink = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
    const analysers = [left, right].map((samples) => ({
      fftSize: 2048,
      connect: vi.fn(),
      disconnect: vi.fn(),
      getFloatTimeDomainData: (target: Float32Array) => target.set(samples),
    }));
    const context = {
      destination: vi.fn().mockReturnValue({})(),
      createChannelSplitter: vi.fn().mockReturnValue(splitter),
      createGain: vi.fn().mockReturnValue(sink),
      createAnalyser: vi
        .fn()
        .mockReturnValueOnce(analysers[0])
        .mockReturnValueOnce(analysers[1]),
    };
    const input = { connect: vi.fn(), disconnect: vi.fn() };
    const tap = createChannelPeakTap(context, input);
    expect(peakDbFromSamples(tap.read())).toBeCloseTo(-0.91515, 4);
    expect(sink.gain.value).toBe(0);
    expect(input.connect).toHaveBeenCalledWith(splitter);
    expect(splitter.connect).toHaveBeenNthCalledWith(1, analysers[0], 0);
    expect(splitter.connect).toHaveBeenNthCalledWith(2, analysers[1], 1);
    tap.dispose();
    expect(input.disconnect).toHaveBeenCalledWith(splitter);
    expect(splitter.disconnect).toHaveBeenCalledOnce();
    expect(sink.disconnect).toHaveBeenCalledOnce();
    for (const analyser of analysers)
      expect(analyser.disconnect).toHaveBeenCalledOnce();
  });
});
