import { pcmWavHeader } from "../../audio/wavHeader";
import { KEEPER_BYTES_PER_SECOND } from "../keeper/pcm";

export { sha256Hex } from "../keeper/fingerprint";

export const RECORD_UPLOAD_WAV_HEADER = pcmWavHeader(0).byteLength;
export const RECORD_UPLOAD_PART_PCM_BYTES = KEEPER_BYTES_PER_SECOND * 30;

/** Split a finalized keeper WAV's PCM into 30 s upload parts. */
export function keeperPcmParts(wav: Uint8Array): Uint8Array[] {
  if (wav.byteLength <= RECORD_UPLOAD_WAV_HEADER) {
    return [];
  }
  const pcm = wav.subarray(RECORD_UPLOAD_WAV_HEADER);
  const size = RECORD_UPLOAD_PART_PCM_BYTES;
  const parts: Uint8Array[] = [];
  let offset = 0;
  while (offset < pcm.length) {
    const end = Math.min(offset + size, pcm.length);
    parts.push(pcm.subarray(offset, end));
    offset = end;
  }
  return parts;
}
