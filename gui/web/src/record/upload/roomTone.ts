import { keeperPcmParts } from "./chunker";
import { uploadKeeperWav } from "./pump";
import type { RecordUploadTransport } from "./transport";

export async function uploadRoomToneWav(args: {
  wav: Uint8Array;
  transport: RecordUploadTransport;
  signal?: AbortSignal;
}): Promise<{ fileAck: boolean; landed: boolean; landFailed: boolean }> {
  const parts = keeperPcmParts(args.wav);
  if (parts.length !== 1 || !parts[0]) {
    throw new Error("room tone must be a single part");
  }
  const { fileAck, landed, landFailed } = await uploadKeeperWav({
    wav: args.wav,
    takeIndex: 0,
    segmentIndex: 0,
    transport: args.transport,
    ackedParts: [],
    fileAck: false,
    kind: "room_tone",
    signal: args.signal,
  });
  return { fileAck, landed, landFailed };
}
