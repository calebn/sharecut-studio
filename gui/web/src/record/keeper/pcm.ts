import { DEFAULT_CLIP_DB } from "../../audio/metering";
import { dbToLinear } from "../../utils/audio";

export const KEEPER_SAMPLE_RATE = 48_000;
export const KEEPER_CHANNELS = 1;
export const KEEPER_BITS = 16;
/** Bytes per mono 16-bit keeper frame. */
export const KEEPER_FRAME_BYTES = (KEEPER_CHANNELS * KEEPER_BITS) / 8;

/** True when a parsed WAV header matches the fixed keeper PCM format. */
export function isKeeperPcmFormat(header: {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  blockAlign: number;
}): boolean {
  return (
    header.audioFormat === 1 &&
    header.channels === KEEPER_CHANNELS &&
    header.sampleRate === KEEPER_SAMPLE_RATE &&
    header.bitsPerSample === KEEPER_BITS &&
    header.blockAlign === KEEPER_FRAME_BYTES
  );
}
/** Uncompressed keeper PCM throughput (mono, 16-bit). */
export const KEEPER_BYTES_PER_SECOND = KEEPER_SAMPLE_RATE * KEEPER_FRAME_BYTES;

/** Linear sample-peak threshold shared with the live meter (-1 dBFS). */
export const KEEPER_CLIP_THRESHOLD = dbToLinear(DEFAULT_CLIP_DB);

export type KeeperEncoded = {
  pcm: Int16Array;
  /** First/last sample index at or above the clip threshold, if any. */
  hot: { first: number; last: number } | null;
};

function encodeInt16(
  input: Float32Array,
  muted: boolean,
  threshold: number,
): KeeperEncoded {
  const pcm = new Int16Array(input.length);
  if (muted) {
    return { pcm, hot: null };
  }
  let first = -1;
  let last = -1;
  for (let i = 0; i < input.length; i++) {
    const s = input[i] ?? 0;
    const clipped = s < -1 ? -1 : s > 1 ? 1 : s;
    pcm[i] =
      clipped < 0 ? Math.round(clipped * 32768) : Math.round(clipped * 32767);
    if (Math.abs(s) >= threshold) {
      if (first < 0) first = i;
      last = i;
    }
  }
  return { pcm, hot: first < 0 ? null : { first, last } };
}

export function floatToInt16(input: Float32Array, muted = false): Int16Array {
  return encodeInt16(input, muted, Number.POSITIVE_INFINITY).pcm;
}

export function resampleLinear(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate || input.length === 0) {
    return input;
  }
  const ratio = toRate / fromRate;
  const outLen = Math.max(1, Math.round(input.length * ratio));
  const out = new Float32Array(outLen);
  const last = input.length - 1;
  for (let i = 0; i < outLen; i++) {
    const src = i / ratio;
    const i0 = Math.min(last, Math.floor(src));
    const i1 = Math.min(last, i0 + 1);
    const frac = src - i0;
    const a = input[i0] ?? 0;
    const b = input[i1] ?? 0;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

export function toKeeperPcm(
  input: Float32Array,
  sourceRate: number,
  muted = false,
): Int16Array {
  const resampled = resampleLinear(input, sourceRate, KEEPER_SAMPLE_RATE);
  return floatToInt16(resampled, muted);
}

/** Encode keeper PCM and report where the samples reached the clip threshold. */
export function encodeKeeperPcm(
  input: Float32Array,
  sourceRate: number,
  {
    muted = false,
    clipThreshold = KEEPER_CLIP_THRESHOLD,
  }: { muted?: boolean; clipThreshold?: number } = {},
): KeeperEncoded {
  const resampled = resampleLinear(input, sourceRate, KEEPER_SAMPLE_RATE);
  return encodeInt16(resampled, muted, clipThreshold);
}
