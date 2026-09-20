import { keeperPcmParts, sha256Hex } from "./chunker";
import type { RecordUploadTransport } from "./transport";

export async function uploadKeeperWav(args: {
  wav: Uint8Array;
  complete: boolean;
  takeIndex: number;
  segmentIndex: number;
  transport: RecordUploadTransport;
  ackedParts: number[];
  fileAck: boolean;
  joinOffsetMs?: number;
  kind?: string;
  signal?: AbortSignal;
}): Promise<{ acked: number; total: number; fileAck: boolean }> {
  if (args.fileAck) {
    const total = Math.max(args.ackedParts.length, 1);
    return { acked: total, total, fileAck: true };
  }
  const parts = keeperPcmParts(args.wav, args.complete);
  const acked = new Set(args.ackedParts);
  let fileAck = false;
  const fileSha = args.complete ? await sha256Hex(args.wav) : undefined;
  for (let partSeq = 0; partSeq < parts.length; partSeq += 1) {
    args.signal?.throwIfAborted?.();
    const data = parts[partSeq];
    if (!data) {
      continue;
    }
    const final = args.complete && partSeq === parts.length - 1;
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
      kind: args.kind,
      signal: args.signal,
    });
    acked.add(partSeq);
    fileAck = result.file_ack;
  }
  return { acked: acked.size, total: parts.length, fileAck };
}
