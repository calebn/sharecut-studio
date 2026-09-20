import { pcmWavHeader } from "../../audio/wavHeader";

export const RECORD_UPLOAD_WAV_HEADER = pcmWavHeader(0).byteLength;
export const RECORD_UPLOAD_PART_PCM_BYTES = 48_000 * 2 * 30;

export function keeperPcmParts(
  wav: Uint8Array,
  complete: boolean,
): Uint8Array[] {
  if (wav.byteLength <= RECORD_UPLOAD_WAV_HEADER) {
    return [];
  }
  const pcm = wav.subarray(RECORD_UPLOAD_WAV_HEADER);
  const size = RECORD_UPLOAD_PART_PCM_BYTES;
  const parts: Uint8Array[] = [];
  let offset = 0;
  while (offset < pcm.length) {
    const end = Math.min(offset + size, pcm.length);
    if (!complete && end - offset < size) {
      break;
    }
    parts.push(pcm.subarray(offset, end));
    offset = end;
  }
  return parts;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
