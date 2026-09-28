import { describe, expect, it } from "vitest";
import { wavPeak } from "./wavPeak";

function writeFourcc(view: DataView, offset: number, id: string): void {
  for (let i = 0; i < 4; i++) view.setUint8(offset + i, id.charCodeAt(i));
}

function buildWav({
  sampleRate = 48000,
  channels = 1,
  bitsPerSample = 16,
  audioFormat = 1,
  samples,
}: {
  sampleRate?: number;
  channels?: number;
  bitsPerSample?: number;
  audioFormat?: number;
  samples: number[];
}): Uint8Array {
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const dataSize = samples.length * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  writeFourcc(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeFourcc(view, 8, "WAVE");
  writeFourcc(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, audioFormat, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeFourcc(view, 36, "data");
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (const s of samples) {
    if (bitsPerSample === 16) {
      view.setInt16(offset, s, true);
    } else if (audioFormat === 3 && bitsPerSample === 32) {
      view.setFloat32(offset, s, true);
    } else if (bitsPerSample === 32) {
      view.setInt32(offset, s, true);
    }
    offset += bytesPerSample;
  }
  return new Uint8Array(buf);
}

describe("wavPeak", () => {
  it("returns 0 for silence", () => {
    const wav = buildWav({ samples: [0, 0, 0, 0] });
    expect(wavPeak(wav)).toBe(0);
  });

  it("returns about 0.5 for an int16 sine at amplitude 16384", () => {
    const wav = buildWav({
      samples: [0, 8192, 16384, 8192, 0, -8192, -16384, -8192],
    });
    expect(wavPeak(wav)).toBeCloseTo(0.5, 4);
  });

  it("returns 0.75 for a float32 WAV", () => {
    const wav = buildWav({
      bitsPerSample: 32,
      audioFormat: 3,
      samples: [0.1, -0.75, 0.3],
    });
    expect(wavPeak(wav)).toBe(0.75);
  });

  it("returns the peak of the bytes present when the data chunk is truncated", () => {
    const full = buildWav({ samples: [10000, 32767, 5000] });
    // Keep the header (which still claims 3 samples) but cut the bytes off
    // after the first two samples.
    const truncated = full.slice(0, 44 + 4);
    expect(wavPeak(truncated)).toBeCloseTo(32767 / 32768, 4);
  });

  it("gives the same result for a view with a non-zero byteOffset", () => {
    const wav = buildWav({ samples: [1000, -20000, 15000] });
    const padded = new Uint8Array(8 + wav.byteLength);
    padded.set(wav, 8);
    const view = new Uint8Array(padded.buffer, 8, wav.byteLength);
    expect(wavPeak(view)).toBe(wavPeak(wav));
  });

  it("throws for a non-WAV input", () => {
    const notWav = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(() => wavPeak(notWav)).toThrow(/RIFF/);
  });
});
