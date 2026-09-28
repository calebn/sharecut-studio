import { peakLinear } from "../src/audio/metering";
import { parseWavHeader, wavPcmToFloat32 } from "../src/audio/wavHeader";

/**
 * Normalized peak amplitude in [0, 1] of a WAV byte buffer. Handles 16/24/32-bit
 * integer and 32-bit float WAVs, and clamps a truncated `data` chunk to the
 * bytes actually present instead of throwing.
 */
export function wavPeak(bytes: Uint8Array): number {
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  );
  const header = parseWavHeader(buffer);
  const dataEnd = Math.min(
    buffer.byteLength,
    header.dataOffset + header.dataSize,
  );
  const pcm = buffer.slice(header.dataOffset, dataEnd);
  // wavPcmToFloat32 yields each frame's absolute peak, so the highest one is
  // the WAV peak. peakLinear loops rather than spreading into Math.max, which
  // overflows the call stack on ~100k+ frames.
  return peakLinear(wavPcmToFloat32(pcm, header));
}
