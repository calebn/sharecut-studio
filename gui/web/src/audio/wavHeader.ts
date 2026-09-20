/** PCM WAV header (fmt + data chunk). Used for HTTP Range → time mapping. */

export type WavHeader = {
  dataOffset: number;
  dataSize: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  /** 1 = integer PCM, 3 = IEEE float. */
  audioFormat: number;
  blockAlign: number;
};

function u16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

function fourcc(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

export function parseWavHeader(buffer: ArrayBufferLike): WavHeader {
  if (buffer.byteLength < 12) {
    throw new Error("WAV header too short");
  }
  const view = new DataView(buffer as ArrayBuffer);
  if (fourcc(view, 0) !== "RIFF" || fourcc(view, 8) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }
  let offset = 12;
  let fmt: {
    audioFormat: number;
    channels: number;
    sampleRate: number;
    bitsPerSample: number;
    blockAlign: number;
  } | null = null;
  let dataOffset = -1;
  let dataSize = 0;
  while (offset + 8 <= view.byteLength) {
    const id = fourcc(view, offset);
    const size = u32(view, offset + 4);
    const body = offset + 8;
    if (id === "fmt " && body + 16 <= view.byteLength) {
      fmt = {
        audioFormat: u16(view, body),
        channels: u16(view, body + 2),
        sampleRate: u32(view, body + 4),
        bitsPerSample: u16(view, body + 14),
        blockAlign: u16(view, body + 12),
      };
    } else if (id === "data") {
      dataOffset = body;
      dataSize = size;
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!fmt || dataOffset < 0) {
    throw new Error("WAV missing fmt or data chunk");
  }
  if (fmt.audioFormat !== 1 && fmt.audioFormat !== 3) {
    throw new Error(`unsupported WAV format ${fmt.audioFormat}`);
  }
  return {
    dataOffset,
    dataSize,
    channels: fmt.channels,
    sampleRate: fmt.sampleRate,
    bitsPerSample: fmt.bitsPerSample,
    audioFormat: fmt.audioFormat,
    blockAlign: fmt.blockAlign || (fmt.channels * fmt.bitsPerSample) / 8,
  };
}

export function byteRangeForTime(
  header: WavHeader,
  startSec: number,
  endSec: number,
): { start: number; endExclusive: number } {
  const startFrame = Math.max(0, Math.floor(startSec * header.sampleRate));
  const endFrame = Math.max(
    startFrame + 1,
    Math.ceil(endSec * header.sampleRate),
  );
  const start = header.dataOffset + startFrame * header.blockAlign;
  const endExclusive = Math.min(
    header.dataOffset + header.dataSize,
    header.dataOffset + endFrame * header.blockAlign,
  );
  return { start, endExclusive };
}

function readSample(view: DataView, offset: number, header: WavHeader): number {
  if (header.audioFormat === 3 && header.bitsPerSample === 32) {
    return view.getFloat32(offset, true);
  }
  if (header.bitsPerSample === 16) {
    return view.getInt16(offset, true) / 32768;
  }
  if (header.bitsPerSample === 32) {
    return view.getInt32(offset, true) / 2147483648;
  }
  if (header.bitsPerSample === 24) {
    const b0 = view.getUint8(offset);
    const b1 = view.getUint8(offset + 1);
    const b2 = view.getUint8(offset + 2);
    let n = b0 | (b1 << 8) | (b2 << 16);
    if (n & 0x800000) {
      n -= 0x1000000;
    }
    return n / 8388608;
  }
  throw new Error(`unsupported bits ${header.bitsPerSample}`);
}

/** Interleaved PCM bytes → mono max-abs float32. */
export function wavPcmToFloat32(
  buffer: ArrayBufferLike,
  header: WavHeader,
): Float32Array {
  const bytesPerFrame = header.blockAlign;
  if (bytesPerFrame <= 0) {
    return new Float32Array(0);
  }
  const frames = Math.floor(buffer.byteLength / bytesPerFrame);
  const out = new Float32Array(frames);
  const view = new DataView(buffer as ArrayBuffer);
  const bytesPerSample = header.bitsPerSample / 8;
  for (let i = 0; i < frames; i++) {
    const base = i * bytesPerFrame;
    let peak = 0;
    for (let ch = 0; ch < header.channels; ch++) {
      const s = readSample(view, base + ch * bytesPerSample, header);
      const a = s < 0 ? -s : s;
      if (a > peak) {
        peak = a;
      }
    }
    out[i] = peak;
  }
  return out;
}

export function isPcmWavPath(path: string | null | undefined): boolean {
  if (!path) {
    return false;
  }
  return /\.wav$/i.test(path);
}

function writeFourcc(view: DataView, offset: number, id: string): void {
  view.setUint8(offset, id.charCodeAt(0));
  view.setUint8(offset + 1, id.charCodeAt(1));
  view.setUint8(offset + 2, id.charCodeAt(2));
  view.setUint8(offset + 3, id.charCodeAt(3));
}

/** 44-byte PCM WAV header. `dataSize` may be 0 while a keeper is still growing. */
export function pcmWavHeader(
  dataSize: number,
  sampleRate = 48000,
  channels = 1,
): Uint8Array {
  const buf = new ArrayBuffer(44);
  const view = new DataView(buf);
  writeFourcc(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeFourcc(view, 8, "WAVE");
  writeFourcc(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeFourcc(view, 36, "data");
  view.setUint32(40, dataSize, true);
  return new Uint8Array(buf);
}

/** 16-bit PCM WAV (RIFF). Used for local keeper files. */
export function encodePcmWav(
  pcm: Int16Array,
  sampleRate = 48000,
  channels = 1,
): Uint8Array {
  const header = pcmWavHeader(pcm.byteLength, sampleRate, channels);
  const bytes = new Uint8Array(44 + pcm.byteLength);
  bytes.set(header, 0);
  bytes.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 44);
  return bytes;
}
