export function recordUploadSearchParams(args: {
  takeIndex: number;
  segmentIndex: number;
  partSeq: number;
  digest: string;
  fileSha256?: string;
  final?: boolean;
  joinOffsetMs?: number;
  kind?: string;
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
  if (args.kind) {
    q.set("kind", args.kind);
  }
  return q;
}

export function copyUploadBody(data: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy;
}
