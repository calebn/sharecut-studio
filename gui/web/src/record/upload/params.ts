import {
  type KeeperClipRegion,
  serializeClipRegions,
} from "../keeper/clipRegions";

export function recordUploadSearchParams(args: {
  takeIndex: number;
  segmentIndex: number;
  partSeq: number;
  digest: string;
  fileSha256?: string;
  final?: boolean;
  joinOffsetMs?: number;
  clippingRegions?: KeeperClipRegion[];
  kind?: string;
  expectedParts?: number;
  extra?: Record<string, string>;
}): URLSearchParams {
  const q = new URLSearchParams({
    take_index: String(args.takeIndex),
    segment_index: String(args.segmentIndex),
    part_seq: String(args.partSeq),
    sha256: args.digest,
    final: args.final ? "true" : "false",
    ...args.extra,
  });
  if (args.fileSha256) {
    q.set("file_sha256", args.fileSha256);
  }
  if (args.joinOffsetMs != null) {
    q.set("join_offset_ms", String(args.joinOffsetMs));
  }
  if (args.clippingRegions && args.clippingRegions.length > 0) {
    q.set("clipping", serializeClipRegions(args.clippingRegions));
  }
  if (args.kind) {
    q.set("kind", args.kind);
  }
  if (args.expectedParts != null) {
    q.set("expected_parts", String(args.expectedParts));
  }
  return q;
}

export function copyUploadBody(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy;
}
