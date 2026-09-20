import { describe, expect, it } from "vitest";
import {
  encodePcmWav,
  parseWavHeader,
  pcmWavHeader,
  wavPcmToFloat32,
} from "./wavHeader";

describe("encodePcmWav", () => {
  it("round-trips 16-bit mono PCM", () => {
    const pcm = new Int16Array([0, 16384, -16384, 32767, -32768]);
    const bytes = encodePcmWav(pcm, 48000, 1);
    const header = parseWavHeader(bytes.buffer);
    expect(header.sampleRate).toBe(48000);
    expect(header.channels).toBe(1);
    expect(header.bitsPerSample).toBe(16);
    expect(header.audioFormat).toBe(1);
    expect(header.dataSize).toBe(pcm.byteLength);
    const peak = wavPcmToFloat32(bytes.buffer.slice(header.dataOffset), header);
    expect(peak.length).toBe(5);
    expect(peak[3]).toBeCloseTo(1, 2);
  });

  it("writes a placeholder header for a growing keeper", () => {
    const header = pcmWavHeader(0, 48000, 1);
    expect(header.byteLength).toBe(44);
    expect(parseWavHeader(header.buffer).dataSize).toBe(0);
  });
});
