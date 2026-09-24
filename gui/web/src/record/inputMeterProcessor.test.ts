import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import source from "./inputMeterProcessor.js?raw";

type Processor = {
  port: {
    onmessage:
      | ((event: { data: { type: string; epoch: number } }) => void)
      | null;
    postMessage: ReturnType<typeof vi.fn>;
  };
  process: (inputs: Float32Array[][]) => boolean;
};

function makeProcessor(clipThreshold = 0.8) {
  let ProcessorClass: new (options: {
    processorOptions: { clipThreshold: number };
  }) => Processor;
  class AudioWorkletProcessor {
    port = { onmessage: null, postMessage: vi.fn() };
  }
  runInNewContext(source, {
    AudioWorkletProcessor,
    registerProcessor: (name: string, ctor: typeof ProcessorClass) => {
      expect(name).toBe("sharecut-input-meter");
      ProcessorClass = ctor;
    },
  });
  return new ProcessorClass!({ processorOptions: { clipThreshold } });
}

describe("input meter worklet", () => {
  it("retains a short safe transient until the next batched report", () => {
    const processor = makeProcessor();
    processor.process([[new Float32Array([-0.7])]]);
    for (let i = 0; i < 6; i++) processor.process([[new Float32Array([0])]]);
    expect(processor.port.postMessage).not.toHaveBeenCalled();
    processor.process([[new Float32Array([0])]]);
    expect(processor.port.postMessage).toHaveBeenCalledWith({
      peak: expect.closeTo(0.7),
      clipped: false,
      epoch: 0,
    });
  });

  it("takes the max absolute sample across every channel and latches clip", () => {
    const processor = makeProcessor();
    expect(
      processor.process([
        [new Float32Array([0.1, -0.4]), new Float32Array([-0.9])],
      ]),
    ).toBe(true);
    expect(processor.port.postMessage).toHaveBeenLastCalledWith({
      peak: expect.closeTo(0.9),
      clipped: true,
      epoch: 0,
    });
    for (let i = 0; i < 8; i++) processor.process([[new Float32Array([0.01])]]);
    expect(processor.port.postMessage).toHaveBeenLastCalledWith({
      peak: expect.closeTo(0.01),
      clipped: true,
      epoch: 0,
    });
  });

  it("clears the sticky clip on a new epoch and sees later hot blocks", () => {
    const processor = makeProcessor();
    processor.process([[new Float32Array([1])]]);
    processor.port.onmessage?.({ data: { type: "clear", epoch: 2 } });
    for (let i = 0; i < 8; i++) processor.process([[new Float32Array([0.1])]]);
    expect(processor.port.postMessage).toHaveBeenLastCalledWith({
      peak: expect.closeTo(0.1),
      clipped: false,
      epoch: 2,
    });
    processor.process([[new Float32Array([-0.81])]]);
    expect(processor.port.postMessage).toHaveBeenLastCalledWith({
      peak: expect.closeTo(0.81),
      clipped: true,
      epoch: 2,
    });
  });
});
