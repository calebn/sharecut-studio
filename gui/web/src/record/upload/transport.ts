export type RecordUploadStatus = {
  session_id?: string;
  segments: Array<{
    take_index: number;
    participant_id: string;
    segment_index: number;
    acked_parts: number[];
    file_ack?: boolean;
    landed?: boolean;
    land_failed?: boolean;
  }>;
};

export type RecordUploadAck = {
  acked: boolean;
  take_index: number;
  participant_id: string;
  segment_index: number;
  part_seq: number;
  file_ack: boolean;
  landed?: boolean;
  land_failed?: boolean;
};

export type RecordUploadPutArgs = {
  takeIndex: number;
  segmentIndex: number;
  partSeq: number;
  data: Uint8Array;
  digest: string;
  fileSha256?: string;
  final?: boolean;
  joinOffsetMs?: number;
  kind?: string;
  signal?: AbortSignal;
};

export type RecordUploadTransport = {
  status(signal?: AbortSignal): Promise<RecordUploadStatus>;
  put(args: RecordUploadPutArgs): Promise<RecordUploadAck>;
  revokeRoomTone?(signal?: AbortSignal): Promise<void>;
};

export function memoryUploadTransport(): RecordUploadTransport & {
  failNext: boolean;
  puts: number;
  joinOffsets: number[];
} {
  const acked = new Map<string, Set<number>>();
  const files = new Set<string>();
  const joinOffsets: number[] = [];
  const state = { failNext: false, puts: 0 };
  const key = (take: number, segment: number) => `${take}:${segment}`;
  return {
    get failNext() {
      return state.failNext;
    },
    set failNext(value: boolean) {
      state.failNext = value;
    },
    get puts() {
      return state.puts;
    },
    joinOffsets,
    async status() {
      const segments = [...acked.entries()].map(([id, parts]) => {
        const [take, segment] = id.split(":").map(Number);
        return {
          take_index: take ?? 0,
          participant_id: "p_a",
          segment_index: segment ?? 0,
          acked_parts: [...parts].sort((a, b) => a - b),
          file_ack: files.has(id),
          landed: files.has(id),
          land_failed: false,
        };
      });
      return { segments };
    },
    async put(args) {
      if (state.failNext) {
        state.failNext = false;
        throw new Error("killed");
      }
      state.puts += 1;
      joinOffsets.push(args.joinOffsetMs ?? 0);
      const id = key(args.takeIndex, args.segmentIndex);
      const parts = acked.get(id) ?? new Set<number>();
      parts.add(args.partSeq);
      acked.set(id, parts);
      if (args.final) {
        files.add(id);
      }
      return {
        acked: true,
        take_index: args.takeIndex,
        participant_id: "p_a",
        segment_index: args.segmentIndex,
        part_seq: args.partSeq,
        file_ack: args.final === true,
        landed: args.final === true,
        land_failed: false,
      };
    },
    async revokeRoomTone() {
      files.clear();
    },
  };
}
