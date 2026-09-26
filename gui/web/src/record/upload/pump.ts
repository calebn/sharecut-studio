import type { KeeperClipRegion } from "../keeper/clipRegions";
import { keeperPcmParts, sha256Hex } from "./chunker";
import type { RecordUploadTransport } from "./transport";

/**
 * Upload a finalized keeper WAV. Pending (still-open or abandoned) segments are
 * never uploaded; they must be finalized or recovered first.
 */
export async function uploadKeeperWav(args: {
  wav: Uint8Array;
  takeIndex: number;
  segmentIndex: number;
  transport: RecordUploadTransport;
  ackedParts: number[];
  fileAck: boolean;
  landed?: boolean;
  landFailed?: boolean;
  joinOffsetMs?: number;
  clippingRegions?: KeeperClipRegion[];
  clippingTruncated?: boolean;
  kind?: string;
  signal?: AbortSignal;
}): Promise<{
  acked: number;
  total: number;
  fileAck: boolean;
  landed: boolean;
  landFailed: boolean;
}> {
  if (args.fileAck) {
    const total = Math.max(args.ackedParts.length, 1);
    return {
      acked: total,
      total,
      fileAck: true,
      landed: args.landed === true,
      landFailed: args.landFailed === true,
    };
  }
  const parts = keeperPcmParts(args.wav);
  if (parts.length === 0) {
    throw new Error(
      "No audio was captured for this take. Resume the upload or download the local keeper copy.",
    );
  }
  const acked = new Set(args.ackedParts);
  let fileAck = false;
  let landed = false;
  let landFailed = false;
  const fileSha = await sha256Hex(args.wav);
  for (let partSeq = 0; partSeq < parts.length; partSeq += 1) {
    args.signal?.throwIfAborted?.();
    const data = parts[partSeq];
    if (!data) {
      continue;
    }
    const final = partSeq === parts.length - 1;
    if (acked.has(partSeq) && !final) {
      continue;
    }
    const digest = await sha256Hex(data);
    const result = await args.transport.put({
      takeIndex: args.takeIndex,
      segmentIndex: args.segmentIndex,
      partSeq,
      data,
      digest,
      fileSha256: final ? fileSha : undefined,
      final,
      joinOffsetMs: args.joinOffsetMs,
      clippingRegions: final ? args.clippingRegions : undefined,
      clippingTruncated: final ? args.clippingTruncated : undefined,
      kind: args.kind,
      expectedParts: parts.length,
      signal: args.signal,
    });
    acked.add(partSeq);
    fileAck = result.file_ack;
    landed = Boolean(result.landed);
    landFailed = Boolean(result.land_failed);
  }
  return {
    acked: acked.size,
    total: parts.length,
    fileAck,
    landed,
    landFailed,
  };
}
