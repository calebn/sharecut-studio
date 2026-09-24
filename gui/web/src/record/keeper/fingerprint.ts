import { sha256 } from "@noble/hashes/sha2.js";
import type { ByteSink } from "./store";

/** SHA-256 of the exact finalized WAV bytes sent to the host. */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Hash an OPFS File in bounded chunks without materializing the whole WAV. */
export async function keeperFileFingerprint(
  sink: ByteSink,
  path: string,
  sourceBlob?: Blob,
): Promise<{ fileSha256: string; byteLength: number } | null> {
  const blob = sourceBlob ?? (await sink.readBlob?.(path));
  if (blob) {
    const hash = sha256.create();
    for (let offset = 0; offset < blob.size; offset += 1024 * 1024) {
      hash.update(
        new Uint8Array(
          await blob.slice(offset, offset + 1024 * 1024).arrayBuffer(),
        ),
      );
    }
    return {
      fileSha256: [...hash.digest()]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
      byteLength: blob.size,
    };
  }
  // Test and older custom sinks may only expose read(). Production OPFS
  // exposes readBlob(), so long recordings always use the bounded path.
  if (sink.readBlob) return null;
  const bytes = await sink.read(path);
  return bytes
    ? { fileSha256: await sha256Hex(bytes), byteLength: bytes.byteLength }
    : null;
}
